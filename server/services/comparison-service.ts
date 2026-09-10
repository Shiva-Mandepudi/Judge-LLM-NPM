import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db.js";
import {
  evalComparisonRuns,
  evalDatasetCases,
  evalDatasetOutputs,
  evalDatasetSubjects,
  evalExperiments,
  evalJudgementsV2,
  evalJobs,
  evalRunManifests,
} from "../../shared/schema.js";
import { getActiveConfig, getConfigVersion } from "../config/config-service.js";
import { enqueueJobTask } from "../workers/cloud-tasks-client.js";
import { judgeComparisonJob, refreshRunStatus, runComparisonJob } from "../workers/comparison-job-runner.js";
import { logAudit } from "./audit-service.js";
import { estimateRunCost } from "./cost-service.js";
import { CANONICAL_TRACK, canonicalDataset, resolveRunCaseSelection } from "./run-case-selection.js";
import { resolveTrack } from "../adapters/cosmic-guidance/track-map.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../config");
const DOCS_DIR = path.resolve(import.meta.dirname, "../../docs/LLM PLAN");

export async function createComparison(db: Db, input: { name: string; candidateModel: string; createdBy: string }) {
  const { dataset } = await canonicalDataset(db);
  const { id: configVersionId } = await getActiveConfig(db, "global");
  const [comparison] = await db.insert(evalExperiments).values({
    name: input.name,
    track: CANONICAL_TRACK,
    datasetId: dataset.id,
    baselineModel: "current-generated-content",
    candidateModel: input.candidateModel,
    baselinePromptVersion: "dataset-current",
    candidatePromptVersion: "configured-track-prompts",
    configVersionId,
    comparisonType: "model",
    // The baseline is read from eval_dataset_outputs, but this legacy column
    // only permits provider execution modes. The dataset role remains clear
    // through baselineModel while the stored value satisfies the DB contract.
    baselineExecutionMode: "cg_standard",
    candidateExecutionMode: "cg_standard",
    createdBy: input.createdBy,
    status: "draft",
  }).returning();
  await logAudit(db, { eventName: "comparison.created", actor: input.createdBy, experimentId: comparison.id, datasetId: dataset.id, configVersionId, model: input.candidateModel });
  return comparison;
}

export async function listComparisons(db: Db) {
  const rows = await db.select().from(evalExperiments).where(eq(evalExperiments.track, CANONICAL_TRACK)).orderBy(desc(evalExperiments.createdAt));
  const runs = await db.select().from(evalComparisonRuns).orderBy(desc(evalComparisonRuns.createdAt));
  return rows.map((comparison) => ({
    ...comparison,
    runs: runs.filter((run) => run.comparisonId === comparison.id),
  }));
}

export async function listComparisonOptions(db: Db) {
  const { dataset, actorKeys } = await canonicalDataset(db);
  const rows = await db
    .select({ track: evalDatasetCases.track, readingType: evalDatasetCases.readingType, readingSubtype: evalDatasetCases.readingSubtype })
    .from(evalDatasetCases)
    .innerJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
    .innerJoin(evalDatasetOutputs, and(eq(evalDatasetOutputs.caseId, evalDatasetCases.id), eq(evalDatasetOutputs.datasetId, dataset.id)))
    .where(and(
      eq(evalDatasetCases.datasetId, dataset.id),
      ne(evalDatasetCases.track, "deterministic"),
      inArray(evalDatasetSubjects.subjectKey, actorKeys),
    ));
  const runnable = rows.filter((row) => resolveTrack(row.track, row.readingType, row.readingSubtype));
  const readingTypes = [...new Set(runnable.map((row) => row.readingType ?? row.track))].sort();
  const readingSubtypes = [...new Set(runnable.map((row) => row.readingSubtype).filter((value): value is "brief" | "detailed" => value === "brief" || value === "detailed"))].sort();
  const readingPairs = [...new Set(runnable.map((row) => `${row.readingType ?? row.track}\u0000${row.readingSubtype ?? ""}`))]
    .map((pair) => { const [readingType, readingSubtype] = pair.split("\u0000"); return { readingType, readingSubtype }; })
    .sort((a, b) => `${a.readingType}:${a.readingSubtype}`.localeCompare(`${b.readingType}:${b.readingSubtype}`));
  return { userKeys: actorKeys, readingTypes, readingSubtypes, readingPairs };
}

// Resolves the pricing linkage stamped on a run at creation time (spec §4.3,
// §6.2): the latest valid snapshot id, the pricing status, and the no-call
// pre-run estimate. Exported so tests can verify the run-start linkage
// directly; the analyze path never touches it, and the snapshot id is never
// overwritten after the run row is inserted.
export async function resolveRunPricing(
  db: Db,
  input: { comparisonId: string; userKeys?: string[]; readingTypes?: string[]; readingSubtypes?: string[] },
): Promise<{ pricingSnapshotId: string | null; pricingStatus: "priced" | "partial" | "unpriced"; costCurrency: "USD"; costEstimate: unknown }> {
  const estimate = await estimateRunCost(db, input);
  if (!estimate.pricedWith.snapshotId) {
    throw new Error("No valid pricing snapshot is available. Sync official prices in Reviews & settings before starting a run.");
  }
  const pricingProblems = estimate.assumptions.filter((assumption) =>
    assumption.startsWith("no pricing rate for candidate") ||
    assumption.startsWith("no pricing rate for primary judge") ||
    assumption.startsWith("no pricing rate for secondary judge") ||
    assumption.startsWith("primary judge model could not") ||
    assumption.startsWith("secondary judge model could not"),
  );
  if (pricingProblems.length > 0) {
    throw new Error(`Cannot start run: ${pricingProblems.join("; ")}. Choose models with official pricing and sync the latest snapshot.`);
  }
  const components = [estimate.estimate.candidate, estimate.estimate.primaryJudge, estimate.estimate.secondaryJudge];
  const pricingStatus = components.every((component) => component.status === "known") ? "priced" : "partial";
  return { pricingSnapshotId: estimate.pricedWith.snapshotId, pricingStatus, costCurrency: "USD", costEstimate: estimate };
}

export async function createComparisonRun(db: Db, input: { comparisonId: string; userKeys?: string[]; readingTypes?: string[]; readingSubtypes?: string[]; createdBy: string }) {
  const selection = await resolveRunCaseSelection(db, input);
  const { comparison, dataset, requestedUsers, requestedReadingTypes, requestedReadingSubtypes, cases } = selection;

  const pricing = await resolveRunPricing(db, {
    comparisonId: input.comparisonId,
    userKeys: requestedUsers,
    readingTypes: requestedReadingTypes,
    readingSubtypes: requestedReadingSubtypes,
  });

  const [run] = await db.insert(evalComparisonRuns).values({
    comparisonId: comparison.id,
    datasetId: dataset.id,
    userKeys: requestedUsers,
    readingTypes: requestedReadingTypes,
    readingSubtypes: requestedReadingSubtypes,
    requestedCases: cases.length,
    createdBy: input.createdBy,
    status: "queued",
    pricingSnapshotId: pricing.pricingSnapshotId,
    pricingStatus: pricing.pricingStatus,
    costCurrency: pricing.costCurrency,
    costEstimate: pricing.costEstimate,
  }).returning();

  await db.insert(evalJobs).values(cases.map((item) => ({
    experimentId: comparison.id,
    runId: run.id,
    caseId: item.id,
    idempotencyKey: `comparison-run:${run.id}:${item.id}`,
  })));
  const { value: configSnapshot } = await getConfigVersion(db, comparison.configVersionId);
  const promptHashes = await buildPromptHashes(cases.map((item) => item.track));
  await db.insert(evalRunManifests).values({
    runId: run.id,
    configSnapshot: { configVersionId: comparison.configVersionId, comparisonId: comparison.id, datasetId: dataset.id, config: configSnapshot, selection: { userKeys: requestedUsers, readingTypes: requestedReadingTypes, readingSubtypes: requestedReadingSubtypes } },
    promptHashes,
    gitSha: process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? null,
    bootstrapSeed: run.id,
    status: "queued",
  });
  await db.update(evalComparisonRuns).set({ status: "running", startedAt: new Date() }).where(eq(evalComparisonRuns.id, run.id));
  await db.update(evalExperiments).set({ status: "running", updatedAt: new Date() }).where(eq(evalExperiments.id, comparison.id));

  const inline = process.env.LOCAL_INLINE_WORKER === "true";
  const jobs = await db.select({ id: evalJobs.id, idempotencyKey: evalJobs.idempotencyKey }).from(evalJobs).where(eq(evalJobs.runId, run.id));
  if (inline) {
    scheduleInlineJobs(db, jobs.map((job) => job.id), {
      runId: run.id,
      comparisonId: comparison.id,
      datasetId: dataset.id,
      createdBy: input.createdBy,
    });
  } else {
    for (const job of jobs) {
      try {
        await enqueueJobTask(job.id, job.idempotencyKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.update(evalJobs).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(evalJobs.id, job.id));
        await logAudit(db, { eventName: "comparison.run.dispatch_failed", actor: input.createdBy, experimentId: comparison.id, jobId: job.id, datasetId: dataset.id, metadata: { runId: run.id, error: message } });
      }
    }
    await refreshRunStatus(db, run.id);
  }
  await logAudit(db, { eventName: "comparison.run.created", actor: input.createdBy, experimentId: comparison.id, datasetId: dataset.id, metadata: { runId: run.id, userCount: requestedUsers.length, readingTypeCount: requestedReadingTypes.length, readingSubtypeCount: requestedReadingSubtypes.length, caseCount: cases.length } });
  const [currentRun] = await db.select().from(evalComparisonRuns).where(eq(evalComparisonRuns.id, run.id));
  return { ...currentRun, userCount: requestedUsers.length, readingTypes: requestedReadingTypes, readingSubtypes: requestedReadingSubtypes, caseCount: cases.length };
}

function scheduleInlineJobs(
  db: Db,
  jobIds: string[],
  input: { runId: string; comparisonId: string; datasetId: string; createdBy: string },
): void {
  setImmediate(() => {
    void (async () => {
      for (const jobId of jobIds) {
        try {
          await runComparisonJob(db, jobId);
        } catch (error) {
          await logAudit(db, {
            eventName: "comparison.run.job_failed",
            actor: input.createdBy,
            experimentId: input.comparisonId,
            jobId,
            datasetId: input.datasetId,
            metadata: { runId: input.runId, error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    })().catch(() => undefined);
  });
}

export async function listComparisonRuns(db: Db) {
  const runs = await db.select().from(evalComparisonRuns).orderBy(desc(evalComparisonRuns.createdAt));
  const comparisons = await db.select().from(evalExperiments).where(eq(evalExperiments.track, CANONICAL_TRACK));
  const jobs = runs.length
    ? await db.select({ id: evalJobs.id, runId: evalJobs.runId, status: evalJobs.status }).from(evalJobs).where(inArray(evalJobs.runId, runs.map((run) => run.id)))
    : [];
  const scores = runs.length
    ? await db.select({ jobId: evalJudgementsV2.jobId, judgeRole: evalJudgementsV2.judgeRole, judgeStatus: evalJudgementsV2.judgeStatus, modelRef: evalJudgementsV2.modelRef }).from(evalJudgementsV2).where(inArray(evalJudgementsV2.jobId, jobs.map((job) => job.id)))
    : [];
  const hasPrimaryPair = (jobId: string) => scores.some((score) => score.jobId === jobId && score.judgeRole === "primary" && score.modelRef === "baseline" && score.judgeStatus === "ok") && scores.some((score) => score.jobId === jobId && score.judgeRole === "primary" && score.modelRef === "candidate" && score.judgeStatus === "ok");
  return runs.map((run) => ({
    ...run,
    cancelledCases: jobs.filter((job) => job.runId === run.id && job.status === "cancelled").length,
    judgedCases: jobs.filter((job) => job.runId === run.id && hasPrimaryPair(job.id)).length,
    analysisNeedsAttention: jobs.some((job) => job.runId === run.id && !hasPrimaryPair(job.id) && job.status === "failed"),
    comparison: comparisons.find((comparison) => comparison.id === run.comparisonId) ?? null,
  }));
}

export async function analyzeComparisonRun(db: Db, input: { runId: string; actor: string }) {
  const [run] = await db.select().from(evalComparisonRuns).where(eq(evalComparisonRuns.id, input.runId));
  if (!run) throw new Error(`Run ${input.runId} not found`);
  if (run.status === "queued" || run.status === "running" || run.status === "cancelled") {
    throw new Error(`Run ${input.runId} must finish generation before it can be analyzed`);
  }

  const jobs = await db.select({ id: evalJobs.id, status: evalJobs.status }).from(evalJobs).where(eq(evalJobs.runId, input.runId));
  await db.update(evalRunManifests).set({ reportSnapshot: null, finalizedAt: null, status: "rejudging" }).where(eq(evalRunManifests.runId, input.runId));
  let analyzedCases = 0;
  let failedCases = 0;
  let repairedCases = 0;
  for (const job of jobs) {
    const scores = await db.select({ judgeRole: evalJudgementsV2.judgeRole, modelRef: evalJudgementsV2.modelRef, judgeStatus: evalJudgementsV2.judgeStatus }).from(evalJudgementsV2).where(eq(evalJudgementsV2.jobId, job.id));
    const analyzed = scores.some((score) => score.judgeRole === "primary" && score.modelRef === "baseline" && score.judgeStatus === "ok") && scores.some((score) => score.judgeRole === "primary" && score.modelRef === "candidate" && score.judgeStatus === "ok");
    if (analyzed) {
      if (job.status === "failed") {
        await db.update(evalJobs).set({ status: "completed", lastError: null, updatedAt: new Date() }).where(and(eq(evalJobs.id, job.id), eq(evalJobs.status, "failed")));
        repairedCases += 1;
      }
      continue;
    }
    try {
      await judgeComparisonJob(db, job.id);
      await db.update(evalJobs).set({ status: "completed", lastError: null, updatedAt: new Date() }).where(eq(evalJobs.id, job.id));
      analyzedCases += 1;
    } catch (error) {
      failedCases += 1;
      await db.update(evalJobs).set({ status: "failed", lastError: error instanceof Error ? `LLM analysis failed: ${error.message}` : `LLM analysis failed: ${String(error)}`, updatedAt: new Date() }).where(eq(evalJobs.id, job.id));
    }
  }
  await refreshRunStatus(db, run.id);
  await logAudit(db, {
    eventName: "comparison.run.analyzed",
    actor: input.actor,
    experimentId: run.comparisonId,
    datasetId: run.datasetId,
    metadata: { runId: run.id, analyzedCases, failedCases, repairedCases },
  });
  return { runId: run.id, analyzedCases, failedCases, repairedCases };
}

async function buildPromptHashes(trackKeys: string[]): Promise<Record<string, string>> {
  const files = [
    path.join(DOCS_DIR, "01-judge-prompt/00-universal-kernel.md"),
    path.join(DOCS_DIR, "02-metric-suite/00-universal-metrics.md"),
    ...[...new Set(trackKeys)].map((track) => path.join(DOCS_DIR, "01-judge-prompt/rubric-packs", `${({ my_day: "my-day", static_scores: "static-scores", number_compatibility: "number-compatibility", zodiac_profile: "zodiac-profile" } as Record<string, string>)[track] ?? track.replace(/_(brief|detailed|full)$/, "")}.md`)),
  ];
  const entries: Record<string, string> = {};
  for (const file of files) {
    const content = await readFile(file, "utf8");
    entries[path.relative(DOCS_DIR, file)] = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  }
  return entries;
}

export async function cancelComparisonRun(db: Db, input: { runId: string; actor: string }) {
  const now = new Date();
  const [run] = await db
    .update(evalComparisonRuns)
    .set({ status: "cancelled", completedAt: now })
    .where(and(eq(evalComparisonRuns.id, input.runId), inArray(evalComparisonRuns.status, ["queued", "running"])))
    .returning();
  if (!run) {
    const [existing] = await db.select({ status: evalComparisonRuns.status }).from(evalComparisonRuns).where(eq(evalComparisonRuns.id, input.runId));
    if (!existing) throw new Error(`Run ${input.runId} not found`);
    throw new Error(`Run ${input.runId} cannot be cancelled because it is ${existing.status}`);
  }

  await db.update(evalJobs).set({ status: "cancelled", lastError: "Cancelled by operator", completedAt: now, updatedAt: now }).where(and(
    eq(evalJobs.runId, input.runId),
    inArray(evalJobs.status, ["pending", "generating", "checking", "judging"]),
  ));
  await logAudit(db, {
    eventName: "comparison.run.cancelled",
    actor: input.actor,
    experimentId: run.comparisonId,
    datasetId: run.datasetId,
    metadata: { runId: run.id },
  });
  return run;
}
