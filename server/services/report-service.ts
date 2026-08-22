import { eq, and, ne, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import {
  evalExperiments,
  evalJobs,
  evalGenerations,
  evalJudgeScores,
  evalDatasetCases,
  evalResultsSummaries,
  type EvalTrack,
} from "../../shared/schema.js";
import { armForLabel, type Arm } from "./blind-ab-service.js";
import { dimensionsForTrack } from "../../shared/rubric.js";

type DimensionScoreMap = Record<string, { score: number; justification: string }>;
type HardGateMap = Record<string, { pass: boolean; violationDetail: string | null }>;

/**
 * Decodes one judge score row's blind labels ("A"/"B") back to real arm
 * names ("baseline"/"candidate") so a human reading the report can tell
 * which model actually won — the judge itself never sees this mapping
 * (framework §2.1 position-bias control), but an admin reviewing results
 * needs it, otherwise "B won" is meaningless without the raw blind map.
 */
export function decodeJudgeScore(
  row: typeof evalJudgeScores.$inferSelect,
  blindLabelMap: { A: Arm; B: Arm },
) {
  const dimensionScores = row.dimensionScores as Record<string, DimensionScoreMap>;
  const hardGateResults = row.hardGateResults as Record<string, HardGateMap>;
  function byArm<T>(labeled: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [label, value] of Object.entries(labeled)) {
      const arm = label === "Tie" ? "Tie" : armForLabel(blindLabelMap, label as "A" | "B");
      out[arm] = value;
    }
    return out;
  }

  const winnerLabel = row.pairwiseWinner as "A" | "B" | "Tie" | null;
  const winnerArm = winnerLabel === null ? null : winnerLabel === "Tie" ? "Tie" : armForLabel(blindLabelMap, winnerLabel);

  return {
    judgeRole: row.judgeRole,
    provider: row.provider,
    model: row.model,
    rubricVersion: row.rubricVersion,
    dimensionScoresByArm: byArm(dimensionScores),
    hardGateResultsByArm: byArm(hardGateResults),
    winnerArm,
    rationale: row.rationale,
    confidenceLevel: row.confidenceLevel,
    latencyMs: row.latencyMs,
    costUsd: row.costUsd,
  };
}

export async function buildExperimentReport(db: Db, experimentId: string) {
  const [experiment] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, experimentId));
  if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

  const track = experiment.track as EvalTrack;

  // "What other models were tried" — every other experiment run against the
  // same track, so an admin can see the full model-comparison history, not
  // just this one baseline/candidate pair.
  const otherExperiments = await db
    .select({
      id: evalExperiments.id,
      name: evalExperiments.name,
      baselineModel: evalExperiments.baselineModel,
      candidateModel: evalExperiments.candidateModel,
      status: evalExperiments.status,
      createdAt: evalExperiments.createdAt,
    })
    .from(evalExperiments)
    .where(and(eq(evalExperiments.track, track), ne(evalExperiments.id, experimentId)))
    .orderBy(evalExperiments.createdAt);

  const results = await db
    .select()
    .from(evalResultsSummaries)
    .where(eq(evalResultsSummaries.experimentId, experimentId))
    .orderBy(evalResultsSummaries.computedAt);
  const latestResult = results.at(-1) ?? null;

  const jobs = await db
    .select({ job: evalJobs, caseKey: evalDatasetCases.caseKey, tags: evalDatasetCases.tags, inputSnapshot: evalDatasetCases.inputSnapshot })
    .from(evalJobs)
    .innerJoin(evalDatasetCases, eq(evalJobs.caseId, evalDatasetCases.id))
    .where(eq(evalJobs.experimentId, experimentId))
    .orderBy(evalJobs.createdAt);

  const jobIds = jobs.map((j) => j.job.id);
  const generations = jobIds.length ? await db.select().from(evalGenerations).where(inArray(evalGenerations.jobId, jobIds)) : [];
  const judgeScores = jobIds.length ? await db.select().from(evalJudgeScores).where(inArray(evalJudgeScores.jobId, jobIds)) : [];

  const jobReports = jobs.map(({ job, caseKey, tags, inputSnapshot }) => {
    const jobGenerations = generations.filter((g) => g.jobId === job.id);
    const jobScores = judgeScores.filter((s) => s.jobId === job.id);
    const primary = jobScores.find((s) => s.judgeRole === "primary");
    const secondary = jobScores.find((s) => s.judgeRole === "secondary");

    return {
      jobId: job.id,
      caseKey,
      tags,
      status: job.status,
      lastError: job.lastError,
      promptVersion: jobGenerations[0]?.promptVersion ?? null,
      inputSnapshot,
      generations: jobGenerations.map((g) => ({
        arm: g.arm,
        model: g.model,
        promptVersion: g.promptVersion,
        schemaValid: g.schemaValid,
        tokensPrompt: g.tokensPrompt,
        tokensCompletion: g.tokensCompletion,
        latencyMs: g.latencyMs,
        costUsd: g.costUsd,
        error: g.error,
      })),
      judge: {
        primary: primary && job.blindLabelMap ? decodeJudgeScore(primary, job.blindLabelMap) : null,
        secondary: secondary && job.blindLabelMap ? decodeJudgeScore(secondary, job.blindLabelMap) : null,
      },
    };
  });

  return {
    experiment: {
      id: experiment.id,
      name: experiment.name,
      track: experiment.track,
      baselineModel: experiment.baselineModel,
      candidateModel: experiment.candidateModel,
      baselinePromptVersion: experiment.baselinePromptVersion,
      candidatePromptVersion: experiment.candidatePromptVersion,
      status: experiment.status,
      createdAt: experiment.createdAt,
    },
    dimensions: dimensionsForTrack(track).map((d) => ({ key: d.key, label: d.label, gate: d.gate, description: d.description })),
    otherModelsTriedOnTrack: otherExperiments,
    latestResult,
    jobs: jobReports,
  };
}
