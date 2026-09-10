import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { evalIdempotencyKeys, evalJobs } from "../../shared/schema.js";
import { requireCloudTasksAuth } from "../auth/service-auth.js";
import { runComparisonJob } from "../workers/comparison-job-runner.js";
import { logger } from "../lib/logger.js";

export const workerRouter = Router();

workerRouter.post("/run-job", requireCloudTasksAuth(), async (req, res) => {
  const { jobId } = req.body as { jobId?: string };
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }

  const [job] = await db.select().from(evalJobs).where(eq(evalJobs.id, jobId));
  if (!job) {
    // Unknown job id: ack so Cloud Tasks stops retrying a task that can never succeed.
    res.status(200).json({ skipped: "unknown_job" });
    return;
  }
  if (job.status === "completed" || job.status === "cancelled") {
    res.status(200).json({ skipped: job.status === "cancelled" ? "cancelled" : "already_completed" });
    return;
  }

  const [existingKey] = await db.select().from(evalIdempotencyKeys).where(eq(evalIdempotencyKeys.key, job.idempotencyKey));
  if (!existingKey) {
    await db.insert(evalIdempotencyKeys).values({ key: job.idempotencyKey, jobId }).onConflictDoNothing();
  }

  try {
    await runComparisonJob(db, jobId);
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("worker_run_job_failed", { jobId, error: String(err) });
    // 500 -> Cloud Tasks retries with its configured backoff; job status is
    // already "failed" in the DB so a human can see it without waiting on retries.
    res.status(500).json({ error: "job_failed" });
  }
});
