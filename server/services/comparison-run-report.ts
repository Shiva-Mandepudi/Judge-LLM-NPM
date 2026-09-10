import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalComparisonRuns, evalDatasetCases, evalDatasetOutputs, evalDatasetSubjects, evalDeterministicResults, evalExperiments, evalGenerations, evalJobs, evalJudgementsV2, evalRunManifests } from "../../shared/schema.js";
import type { JudgeResponse, ScoreRow } from "../core/contracts/evaluation.js";
import { compositeQuality, pairedClusterBootstrap } from "../core/stats/bootstrap.js";
import { loadThresholdsConfig } from "../core/config/loader.js";
import path from "node:path";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../config");
type Arm = "baseline" | "candidate";

function decodeResponse(value: unknown): JudgeResponse | null {
  if (!value || typeof value !== "object") return null;
  const wrapped = value as { validated?: unknown };
  const response = Object.prototype.hasOwnProperty.call(wrapped, "validated") ? wrapped.validated : value;
  return response && typeof response === "object" ? response as JudgeResponse : null;
}

function evidenceView(score: typeof evalJudgementsV2.$inferSelect | undefined) {
  if (!score) return null;
  return { status: score.judgeStatus, provider: score.judgeProvider, model: score.judgeModel, effort: score.judgeEffort, attempt: score.attempt, latencyMs: score.latencyMs, costUsd: score.costUsd, hashes: { kernel: score.kernelHash, rubricPack: score.rubricPackHash, schema: score.schemaHash }, response: decodeResponse(score.response), rawResponse: score.response };
}

const DETERMINISTIC_HARD_CHECKS = new Set(["schema_compliance", "safety_no_absolute_claims", "safety_injection_not_followed", "numerology_calc_value_unmodified", "card_fidelity", "date_correctness", "astronomical_accuracy", "injected_value_fidelity", "score_coverage", "sign_attribute_accuracy", "famous_people_plausibility"]);

function scoreFor(response: JudgeResponse | null, arm: Arm, userId: string, track: string, deterministic: Array<{ checkName: string; passed: boolean }>): ScoreRow | null {
  if (!response) return null;
  return { userId, modelRef: arm, track, metrics: Object.fromEntries(Object.entries(response.metrics).map(([key, result]) => [key, result.score])), gates: { ...Object.fromEntries(Object.entries(response.metrics).filter(([, result]) => result.gate !== undefined).map(([key, result]) => [key, result.gate === "pass" ? true : result.gate === "fail" ? false : null])), ...Object.fromEntries(deterministic.filter((item) => DETERMINISTIC_HARD_CHECKS.has(item.checkName)).map((item) => [`deterministic.${item.checkName}`, item.passed])) }, abstentions: Object.fromEntries(Object.entries(response.metrics).map(([key, result]) => [key, result.score === null])) };
}

function hardFailureCount(response: JudgeResponse | null): number {
  return response ? Object.values(response.metrics).filter((metric) => metric.gate === "fail").length : 0;
}

function deterministicFailureCount(results: Array<{ checkName: string; passed: boolean }>): number {
  return results.filter((item) => DETERMINISTIC_HARD_CHECKS.has(item.checkName) && !item.passed).length;
}

function winnerFor(baseline: JudgeResponse | null, candidate: JudgeResponse | null, weights: Record<string, number>, baselineDeterministicFailures = 0, candidateDeterministicFailures = 0): Arm | "Tie" | null {
  if (!baseline || !candidate) return null;
  const baselineHard = hardFailureCount(baseline) + baselineDeterministicFailures;
  const candidateHard = hardFailureCount(candidate) + candidateDeterministicFailures;
  if (baselineHard !== candidateHard) return baselineHard < candidateHard ? "baseline" : "candidate";
  const baselineScore = compositeQuality(Object.fromEntries(Object.entries(baseline.metrics).map(([key, value]) => [key, value.score])), weights);
  const candidateScore = compositeQuality(Object.fromEntries(Object.entries(candidate.metrics).map(([key, value]) => [key, value.score])), weights);
  if (baselineScore === null || candidateScore === null || Math.abs(baselineScore - candidateScore) < 0.000001) return "Tie";
  return baselineScore > candidateScore ? "baseline" : "candidate";
}

export async function buildComparisonRunReport(db: Db, runId: string) {
  const [run] = await db.select().from(evalComparisonRuns).where(eq(evalComparisonRuns.id, runId));
  if (!run) throw new Error(`Run ${runId} not found`);
  const [comparison] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, run.comparisonId));
  if (!comparison) throw new Error(`Comparison ${run.comparisonId} not found`);
  const [manifest] = await db.select().from(evalRunManifests).where(eq(evalRunManifests.runId, runId));
  const snapshot = manifest?.reportSnapshot as { report?: unknown } | null;
  if (snapshot?.report && (run.status === "completed" || run.status === "failed")) return snapshot.report;
  const jobs = await db.select({ job: evalJobs, case: evalDatasetCases, subjectKey: evalDatasetSubjects.subjectKey }).from(evalJobs).innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId)).leftJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId)).where(eq(evalJobs.runId, runId)).orderBy(asc(evalDatasetSubjects.subjectKey), asc(evalDatasetCases.caseKey));
  const jobIds = jobs.map(({ job }) => job.id);
  const caseIds = jobs.map(({ case: datasetCase }) => datasetCase.id);
  const outputs = jobIds.length ? await db.select().from(evalGenerations).where(inArray(evalGenerations.jobId, jobIds)) : [];
  const current = caseIds.length ? await db.select().from(evalDatasetOutputs).where(inArray(evalDatasetOutputs.caseId, caseIds)) : [];
  const judgements = jobIds.length ? await db.select().from(evalJudgementsV2).where(inArray(evalJudgementsV2.jobId, jobIds)) : [];
  const deterministic = jobIds.length ? await db.select().from(evalDeterministicResults).where(inArray(evalDeterministicResults.jobId, jobIds)) : [];
  const thresholds = loadThresholdsConfig(CONFIG_DIR);
  const primaryByJob = new Map<string, Partial<Record<Arm, typeof evalJudgementsV2.$inferSelect>>>();
  const secondaryByJob = new Map<string, Partial<Record<Arm, typeof evalJudgementsV2.$inferSelect>>>();
  for (const judgement of judgements) {
    const target = judgement.judgeRole === "secondary" ? secondaryByJob : primaryByJob;
    const arms = target.get(judgement.jobId ?? "") ?? {};
    const arm = judgement.modelRef as Arm;
    const existing = arms[arm];
    // Retries are immutable audit rows. Prefer a valid result over a later
    // failed retry so one bad retry cannot hide an earlier usable judgement.
    if (!existing || (judgement.judgeStatus === "ok" && existing.judgeStatus !== "ok") || (judgement.judgeStatus === existing.judgeStatus && judgement.attempt > existing.attempt)) arms[arm] = judgement;
    target.set(judgement.jobId ?? "", arms);
  }
  const caseResults = jobs.map(({ job, case: datasetCase, subjectKey }) => {
    const primary = primaryByJob.get(job.id) ?? {};
    const secondary = secondaryByJob.get(job.id) ?? {};
    const primaryBaseline = decodeResponse(primary.baseline?.response);
    const primaryCandidate = decodeResponse(primary.candidate?.response);
    const secondaryBaseline = decodeResponse(secondary.baseline?.response);
    const secondaryCandidate = decodeResponse(secondary.candidate?.response);
    const checks = (arm: Arm) => deterministic.filter((item) => item.jobId === job.id && item.arm === arm);
    const baselineChecks = checks("baseline");
    const candidateChecks = checks("candidate");
    return { job, datasetCase, subjectKey, primary, secondary, primaryBaseline, primaryCandidate, secondaryBaseline, secondaryCandidate, baselineChecks, candidateChecks, primaryWinner: winnerFor(primaryBaseline, primaryCandidate, thresholds.composite.weights, deterministicFailureCount(baselineChecks), deterministicFailureCount(candidateChecks)), secondaryWinner: winnerFor(secondaryBaseline, secondaryCandidate, thresholds.composite.weights, deterministicFailureCount(baselineChecks), deterministicFailureCount(candidateChecks)) };
  });
  const judged = caseResults.filter((result) => result.primaryWinner !== null);
  const candidateWins = judged.filter((result) => result.primaryWinner === "candidate").length;
  const baselineWins = judged.filter((result) => result.primaryWinner === "baseline").length;
  const ties = judged.filter((result) => result.primaryWinner === "Tie").length;
  const secondaryComparisons = caseResults.filter((result) => result.primaryWinner !== null && result.secondaryWinner !== null);
  // Bootstrap statistics are paired by design. A failed/partially judged case
  // may have only one valid arm; omit that incomplete pair instead of allowing
  // the statistics layer to crash the entire report.
  const scoreRows = caseResults.flatMap((result) => {
    const userId = result.subjectKey ?? result.datasetCase.caseKey;
    const track = result.datasetCase.readingType ?? result.datasetCase.track;
    const baseline = scoreFor(result.primaryBaseline, "baseline", userId, track, result.baselineChecks);
    const candidate = scoreFor(result.primaryCandidate, "candidate", userId, track, result.candidateChecks);
    return baseline && candidate ? [baseline, candidate] : [];
  });
  const statistics = scoreRows.length ? pairedClusterBootstrap(scoreRows, "baseline", thresholds.composite.weights, thresholds.statistics.bootstrapIterations, hashSeed(runId)) : null;
  const cancelledCases = jobs.filter(({ job }) => job.status === "cancelled").length;
  return {
    comparison: { id: comparison.id, name: comparison.name, model: comparison.candidateModel, baselineModel: comparison.baselineModel, datasetId: comparison.datasetId, configVersionId: comparison.configVersionId, createdAt: comparison.createdAt },
    run: { ...run, userCount: run.userKeys.length, cancelledCases, coverage: { requested: run.requestedCases, completed: run.completedCases, failed: run.failedCases, cancelled: cancelledCases }, manifest: manifest ? { configSnapshot: manifest.configSnapshot, promptHashes: manifest.promptHashes, gitSha: manifest.gitSha, bootstrapSeed: manifest.bootstrapSeed, status: manifest.status, finalizedAt: manifest.finalizedAt } : null },
    analysis: { status: judged.length === 0 ? "not_analyzed" : judged.length === jobs.length && jobs.every(({ job }) => job.status !== "failed") ? "complete" : "partial", judgedCases: judged.length, totalCases: jobs.length, candidateWins, baselineWins, ties, candidateWinPlusTieRate: judged.length ? (candidateWins + ties) / judged.length : null, hardGateFailures: judged.reduce((sum, result) => sum + hardFailureCount(result.primaryBaseline) + hardFailureCount(result.primaryCandidate) + deterministicFailureCount(result.baselineChecks) + deterministicFailureCount(result.candidateChecks), 0), secondaryJudgeCases: secondaryComparisons.length, secondaryDisagreements: secondaryComparisons.filter((result) => result.primaryWinner !== result.secondaryWinner).length, primaryJudge: judged[0]?.primary.candidate ? { provider: judged[0].primary.candidate.judgeProvider, model: judged[0].primary.candidate.judgeModel } : null, winnerPolicy: "deterministic hard gates first, then primary LLM hard gates, then configured composite quality; ties are explicit", statistics },
    readings: caseResults.map((result) => ({ jobId: result.job.id, subjectKey: result.subjectKey, caseKey: result.datasetCase.caseKey, readingType: result.datasetCase.readingType ?? result.datasetCase.track, readingSubtype: result.datasetCase.readingSubtype, status: result.job.status, error: result.job.lastError, inputSnapshot: result.datasetCase.inputSnapshot, currentReading: current.find((item) => item.caseId === result.datasetCase.id) ?? null, generatedReadings: outputs.filter((item) => item.jobId === result.job.id), deterministicChecks: { baseline: result.baselineChecks, candidate: result.candidateChecks }, judge: { primary: { winnerArm: result.primaryWinner, baseline: evidenceView(result.primary.baseline), candidate: evidenceView(result.primary.candidate) }, secondary: result.secondaryWinner === null && !result.secondary.baseline && !result.secondary.candidate ? null : { winnerArm: result.secondaryWinner, baseline: evidenceView(result.secondary.baseline), candidate: evidenceView(result.secondary.candidate) } } })),
  };
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0 || 1;
}
