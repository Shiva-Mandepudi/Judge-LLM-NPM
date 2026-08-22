import { eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalExperiments, evalDatasetCases, evalJobs, type EvalTrack } from "../../shared/schema.js";
import { getActiveConfig } from "../config/config-service.js";
import { enqueueJobTask } from "../workers/cloud-tasks-client.js";
import { runJob } from "../workers/job-runner.js";
import { logAudit } from "./audit-service.js";
import { logger } from "../lib/logger.js";

export interface CreateExperimentParams {
  name: string;
  track: EvalTrack;
  datasetId: string;
  baselineModel: string;
  candidateModel: string;
  baselinePromptVersion: string;
  candidatePromptVersion: string;
  createdBy: string;
}

export async function createExperiment(db: Db, params: CreateExperimentParams): Promise<{ id: string }> {
  const { id: configVersionId, value: config } = await getActiveConfig(db, "global");

  const [experiment] = await db
    .insert(evalExperiments)
    .values({
      name: params.name,
      track: params.track,
      datasetId: params.datasetId,
      baselineModel: params.baselineModel,
      candidateModel: params.candidateModel,
      baselinePromptVersion: params.baselinePromptVersion,
      candidatePromptVersion: params.candidatePromptVersion,
      configVersionId,
      secondaryJudgeSampleRate: config.secondaryJudgeSampleRate,
      createdBy: params.createdBy,
    })
    .returning();

  await logAudit(db, { eventName: "experiment.created", actor: params.createdBy, experimentId: experiment.id, configVersionId, metadata: { track: params.track } });
  return { id: experiment.id };
}

/**
 * Fans the experiment out into one job per dataset case and dispatches each
 * job asynchronously (Cloud Tasks in production; inline in local dev when
 * LOCAL_INLINE_WORKER=true). Idempotent: re-running for an experiment that
 * already has jobs only creates jobs for cases that don't have one yet.
 */
export async function enqueueExperimentJobs(db: Db, experimentId: string): Promise<{ enqueued: number; skipped: number }> {
  const [experiment] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, experimentId));
  if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

  const cases = await db.select().from(evalDatasetCases).where(eq(evalDatasetCases.datasetId, experiment.datasetId));
  if (cases.length === 0) throw new Error(`Dataset ${experiment.datasetId} has no cases`);

  let enqueued = 0;
  let skipped = 0;
  const inline = process.env.LOCAL_INLINE_WORKER === "true";

  for (const caseRow of cases) {
    const idempotencyKey = `${experimentId}:${caseRow.id}`;
    const inserted = await db
      .insert(evalJobs)
      .values({ experimentId, caseId: caseRow.id, idempotencyKey })
      .onConflictDoNothing()
      .returning({ id: evalJobs.id });

    if (inserted.length === 0) {
      skipped++;
      continue;
    }
    enqueued++;

    if (inline) {
      await runJob(db, inserted[0].id).catch((err) => logger.error("inline_job_failed", { jobId: inserted[0].id, error: String(err) }));
    } else {
      await enqueueJobTask(inserted[0].id, idempotencyKey);
    }
  }

  await db.update(evalExperiments).set({ status: "running", updatedAt: new Date() }).where(eq(evalExperiments.id, experimentId));
  await logAudit(db, { eventName: "experiment.jobs_enqueued", actor: "experiment-service", experimentId, metadata: { enqueued, skipped, inline } });
  return { enqueued, skipped };
}

/**
 * Re-runs every job currently in "failed" status for this experiment. A job
 * fails for reasons that are often transient/external (e.g. Cosmic
 * Guidance's internal endpoint being down or misconfigured, not a defect in
 * the generated content itself) — without this, a failed job is stuck
 * forever once enqueueExperimentJobs' onConflictDoNothing skips it as
 * already-existing. Resets status/lastError before re-dispatching so the
 * job runs exactly like a fresh one.
 */
export async function retryFailedJobs(db: Db, experimentId: string, actor: string): Promise<{ retried: number }> {
  const [experiment] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, experimentId));
  if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

  const failedJobs = await db.select().from(evalJobs).where(and(eq(evalJobs.experimentId, experimentId), eq(evalJobs.status, "failed")));
  if (failedJobs.length === 0) return { retried: 0 };

  const inline = process.env.LOCAL_INLINE_WORKER === "true";
  for (const job of failedJobs) {
    await db.update(evalJobs).set({ status: "pending", lastError: null, updatedAt: new Date() }).where(eq(evalJobs.id, job.id));
    if (inline) {
      await runJob(db, job.id).catch((err) => logger.error("inline_retry_failed", { jobId: job.id, error: String(err) }));
    } else {
      await enqueueJobTask(job.id, job.idempotencyKey);
    }
  }

  await logAudit(db, { eventName: "experiment.jobs_retried", actor, experimentId, metadata: { retried: failedJobs.length } });
  return { retried: failedJobs.length };
}
