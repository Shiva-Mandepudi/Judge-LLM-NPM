import { eq, and, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalJobs, evalJudgeScores, evalGenerations, evalExperiments, evalDeterministicResults, evalDatasetCases, type EvalTrack } from "../../shared/schema.js";
import { getActiveConfig } from "../config/config-service.js";
import { computeExperimentStats, type JobStatsInput, type ExperimentStats } from "./stats-service.js";
import { decide, type DecisionResult } from "./decision-service.js";
import { minSampleSizeFor } from "../../shared/sample-plan.js";
import type { JudgeOutput } from "./judge-client.js";
import { logAudit } from "./audit-service.js";
import { evalResultsSummaries } from "../../shared/schema.js";

async function buildJobStatsInputs(db: Db, experimentId: string): Promise<JobStatsInput[]> {
  const jobs = await db
    .select({ job: evalJobs, tags: evalDatasetCases.tags })
    .from(evalJobs)
    .innerJoin(evalDatasetCases, eq(evalJobs.caseId, evalDatasetCases.id))
    .where(and(eq(evalJobs.experimentId, experimentId), eq(evalJobs.status, "completed")));

  const inputs: JobStatsInput[] = [];
  for (const { job, tags } of jobs) {
    if (!job.blindLabelMap) continue;
    const scores = await db.select().from(evalJudgeScores).where(eq(evalJudgeScores.jobId, job.id));
    const primary = scores.find((s) => s.judgeRole === "primary");
    const secondary = scores.find((s) => s.judgeRole === "secondary");
    if (!primary) continue;

    const detResults = await db.select().from(evalDeterministicResults).where(eq(evalDeterministicResults.jobId, job.id));
    const detHardFailures = detResults.filter((r) => !r.passed).length;
    const judgeHardFailures = [primary, ...(secondary ? [secondary] : [])].reduce((sum, s) => {
      const gates = s.hardGateResults as Record<string, Record<string, { pass: boolean }>>;
      return sum + Object.values(gates).flatMap((g) => Object.values(g)).filter((g) => !g.pass).length;
    }, 0);

    inputs.push({
      blindLabelMap: job.blindLabelMap,
      primaryOutput: rowToJudgeOutput(primary),
      secondaryOutput: secondary ? rowToJudgeOutput(secondary) : undefined,
      hardFailureCount: detHardFailures + judgeHardFailures,
      tags: tags ?? [],
    });
  }
  return inputs;
}

const RECOMMENDATION_SEVERITY = { pass: 0, hold: 1, rollback: 2 } as const;

// judge-llm-evaluation-framework.md §6.3: each reading type gates
// independently. brief_readings pools natal/transit/synastry/composite/
// number_compat/tarot into one DB track (see shared/schema.ts), so without
// this, a tarot regression can hide inside a blended aggregate that still
// looks fine on average. Per-tag results make that regression visible, and
// the experiment-level recommendation is downgraded to the worst per-tag
// verdict so a hidden failure can never be masked by an overall pass.
function computePerTagResults(
  jobInputs: JobStatsInput[],
  track: EvalTrack,
  thresholds: Parameters<typeof decide>[1],
  humanReviewTriggers: Parameters<typeof decide>[2],
): Record<string, { stats: ExperimentStats; decision: DecisionResult }> {
  const tags = new Set<string>();
  for (const job of jobInputs) for (const t of job.tags) tags.add(t);

  const perTag: Record<string, { stats: ExperimentStats; decision: DecisionResult }> = {};
  for (const tag of tags) {
    const subset = jobInputs.filter((j) => j.tags.includes(tag));
    const stats = computeExperimentStats(subset);
    const decision = decide(stats, thresholds, humanReviewTriggers, minSampleSizeFor(track, tag));
    perTag[tag] = { stats, decision };
  }
  return perTag;
}

function rowToJudgeOutput(row: typeof evalJudgeScores.$inferSelect): JudgeOutput {
  return {
    dimensionScores: row.dimensionScores as JudgeOutput["dimensionScores"],
    hardGateResults: row.hardGateResults as JudgeOutput["hardGateResults"],
    pairwiseWinner: row.pairwiseWinner as JudgeOutput["pairwiseWinner"],
    rationale: row.rationale ?? "",
    confidence: { level: (row.confidenceLevel as "low" | "medium" | "high") ?? "medium", reason: "" },
  };
}

async function computeCostLatencyComparison(db: Db, experimentId: string) {
  const rows = await db
    .select({
      arm: evalGenerations.arm,
      avgCost: sql<number>`avg(${evalGenerations.costUsd})`,
      avgLatency: sql<number>`avg(${evalGenerations.latencyMs})`,
      totalTokens: sql<number>`sum(${evalGenerations.tokensPrompt} + ${evalGenerations.tokensCompletion})`,
    })
    .from(evalGenerations)
    .innerJoin(evalJobs, eq(evalGenerations.jobId, evalJobs.id))
    .where(eq(evalJobs.experimentId, experimentId))
    .groupBy(evalGenerations.arm);

  const byArm = Object.fromEntries(rows.map((r) => [r.arm, { avgCostUsd: r.avgCost, avgLatencyMs: r.avgLatency, totalTokens: r.totalTokens }]));
  return { costComparison: { baseline: byArm.baseline?.avgCostUsd ?? null, candidate: byArm.candidate?.avgCostUsd ?? null }, latencyComparison: { baseline: byArm.baseline?.avgLatencyMs ?? null, candidate: byArm.candidate?.avgLatencyMs ?? null } };
}

export async function computeAndPersistResults(db: Db, experimentId: string, actor: string) {
  const [experiment] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, experimentId));
  if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

  const { value: config } = await getActiveConfig(db, "global");
  const jobInputs = await buildJobStatsInputs(db, experimentId);
  if (jobInputs.length === 0) throw new Error(`Experiment ${experimentId} has no completed jobs yet.`);

  const track = experiment.track as EvalTrack;
  const stats = computeExperimentStats(jobInputs);
  const overallDecision = decide(stats, config.thresholds, config.humanReviewTriggers, minSampleSizeFor(track));
  const perTagResults = computePerTagResults(jobInputs, track, config.thresholds, config.humanReviewTriggers);

  // The persisted recommendation is the worst of the overall decision and
  // every per-tag decision, so a regression confined to one reading type
  // can never be masked by a blended-average pass (framework §6.3).
  const worstPerTag = Object.values(perTagResults)
    .map((r) => r.decision)
    .reduce<DecisionResult | null>((worst, d) => (!worst || RECOMMENDATION_SEVERITY[d.recommendation] > RECOMMENDATION_SEVERITY[worst.recommendation] ? d : worst), null);
  const decision =
    worstPerTag && RECOMMENDATION_SEVERITY[worstPerTag.recommendation] > RECOMMENDATION_SEVERITY[overallDecision.recommendation] ? worstPerTag : overallDecision;

  const { costComparison, latencyComparison } = await computeCostLatencyComparison(db, experimentId);

  const [summary] = await db
    .insert(evalResultsSummaries)
    .values({
      experimentId,
      sampleSize: stats.sampleSize,
      meanDimensionScores: stats.meanDimensionScores,
      dimensionDeltas: stats.dimensionDeltas,
      winRate: stats.winRate,
      tieRate: stats.tieRate,
      lossRate: stats.lossRate,
      hardGateFailureCount: stats.hardGateFailureCount,
      judgeAgreementRate: stats.judgeAgreementRate,
      nonInferiorityPass: decision.nonInferiorityPass,
      recommendation: decision.recommendation,
      recommendationReasons: decision.reasons,
      perTagResults,
      costComparison,
      latencyComparison,
    })
    .returning();

  await logAudit(db, { eventName: "results.computed", actor, experimentId, metadata: { recommendation: decision.recommendation, sampleSize: stats.sampleSize } });
  return summary;
}
