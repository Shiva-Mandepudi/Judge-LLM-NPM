import { and, desc, eq, inArray, like, ne } from "drizzle-orm";
import path from "node:path";
import type { Db } from "../db.js";
import {
  evalComparisonRuns,
  evalDatasetCases,
  evalDatasetSubjects,
  evalDatasets,
  evalExperiments,
  evalJobs,
} from "../../shared/schema.js";
import { getActiveConfig } from "../config/config-service.js";
import { loadDatasetsConfig } from "../core/config/loader.js";
import { enqueueJobTask } from "../workers/cloud-tasks-client.js";
import { logAudit } from "./audit-service.js";

const CANONICAL_TRACK = "cg_batch_corpus";
const CONFIG_DIR = path.resolve(import.meta.dirname, "../../config");

async function canonicalDataset(db: Db) {
  const version = loadDatasetsConfig(CONFIG_DIR).production.corpus;
  const [dataset] = await db
    .select()
    .from(evalDatasets)
    .where(and(eq(evalDatasets.track, CANONICAL_TRACK), eq(evalDatasets.version, version)));
  if (!dataset) throw new Error(`canonical dataset ${CANONICAL_TRACK}/${version} is not registered`);

  const actors = await db
    .select({ subjectKey: evalDatasetSubjects.subjectKey })
    .from(evalDatasetSubjects)
    .where(and(eq(evalDatasetSubjects.datasetId, dataset.id), like(evalDatasetSubjects.subjectKey, "cb-actor-%")));
  if (actors.length !== 100) throw new Error(`canonical dataset must contain exactly 100 actor subjects; found ${actors.length}`);
  return { dataset, actorKeys: actors.map((actor) => actor.subjectKey).sort() };
}

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
    .select({ track: evalDatasetCases.track, readingType: evalDatasetCases.readingType })
    .from(evalDatasetCases)
    .where(and(eq(evalDatasetCases.datasetId, dataset.id), ne(evalDatasetCases.track, "deterministic")));
  const readingTypes = [...new Set(rows.map((row) => row.readingType ?? row.track))].sort();
  return { userKeys: actorKeys, readingTypes };
}

export async function createComparisonRun(db: Db, input: { comparisonId: string; userKeys?: string[]; readingTypes?: string[]; createdBy: string }) {
  const [comparison] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, input.comparisonId));
  if (!comparison || comparison.track !== CANONICAL_TRACK) throw new Error("comparison not found");
  const { dataset, actorKeys } = await canonicalDataset(db);
  if (comparison.datasetId !== dataset.id) throw new Error("comparison is not attached to the canonical 100-user dataset");

  const requestedUsers = [...new Set(input.userKeys?.length ? input.userKeys : actorKeys)];
  const unknownUsers = requestedUsers.filter((key) => !actorKeys.includes(key));
  if (unknownUsers.length) throw new Error(`unknown dataset users: ${unknownUsers.join(", ")}`);

  const allCases = await db
    .select({ id: evalDatasetCases.id, track: evalDatasetCases.track, readingType: evalDatasetCases.readingType })
    .from(evalDatasetCases)
    .innerJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
    .where(and(
      eq(evalDatasetCases.datasetId, dataset.id),
      ne(evalDatasetCases.track, "deterministic"),
      inArray(evalDatasetSubjects.subjectKey, requestedUsers),
    ));
  const availableReadingTypes = [...new Set(allCases.map((item) => item.readingType ?? item.track))];
  const requestedReadingTypes = [...new Set(input.readingTypes?.length ? input.readingTypes : availableReadingTypes)];
  const unknownReadingTypes = requestedReadingTypes.filter((readingType) => !availableReadingTypes.includes(readingType));
  if (unknownReadingTypes.length) throw new Error(`unknown reading types: ${unknownReadingTypes.join(", ")}`);
  const cases = allCases.filter((item) => requestedReadingTypes.includes(item.readingType ?? item.track));
  if (!cases.length) throw new Error("selected users have no reading cases in the canonical dataset");

  const [run] = await db.insert(evalComparisonRuns).values({
    comparisonId: comparison.id,
    datasetId: dataset.id,
    userKeys: requestedUsers,
    readingTypes: requestedReadingTypes,
    requestedCases: cases.length,
    createdBy: input.createdBy,
    status: "queued",
  }).returning();

  await db.insert(evalJobs).values(cases.map((item) => ({
    experimentId: comparison.id,
    runId: run.id,
    caseId: item.id,
    idempotencyKey: `comparison-run:${run.id}:${item.id}`,
  })));
  await db.update(evalComparisonRuns).set({ status: "running", startedAt: new Date() }).where(eq(evalComparisonRuns.id, run.id));
  await db.update(evalExperiments).set({ status: "running", updatedAt: new Date() }).where(eq(evalExperiments.id, comparison.id));

  const inline = process.env.LOCAL_INLINE_WORKER === "true";
  for (const job of await db.select({ id: evalJobs.id, idempotencyKey: evalJobs.idempotencyKey }).from(evalJobs).where(eq(evalJobs.runId, run.id))) {
    if (inline) {
      const { runJob } = await import("../workers/job-runner.js");
      await runJob(db, job.id);
    } else {
      await enqueueJobTask(job.id, job.idempotencyKey);
    }
  }
  await logAudit(db, { eventName: "comparison.run.created", actor: input.createdBy, experimentId: comparison.id, datasetId: dataset.id, metadata: { runId: run.id, userCount: requestedUsers.length, readingTypeCount: requestedReadingTypes.length, caseCount: cases.length } });
  return { ...run, status: "running", userCount: requestedUsers.length, readingTypes: requestedReadingTypes, caseCount: cases.length };
}

export async function listComparisonRuns(db: Db) {
  const runs = await db.select().from(evalComparisonRuns).orderBy(desc(evalComparisonRuns.createdAt));
  const comparisons = await db.select().from(evalExperiments).where(eq(evalExperiments.track, CANONICAL_TRACK));
  return runs.map((run) => ({ ...run, comparison: comparisons.find((comparison) => comparison.id === run.comparisonId) ?? null }));
}
