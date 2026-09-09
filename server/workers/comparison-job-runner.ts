import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalComparisonRuns, evalDatasetCases, evalDatasetOutputs, evalExperiments, evalGenerations, evalJobs } from "../../shared/schema.js";
import { getActiveConfig } from "../config/config-service.js";
import { requestGeneration } from "../services/generation-client.js";
import { logAudit } from "../services/audit-service.js";

export async function runComparisonJob(db: Db, jobId: string): Promise<void> {
  const [row] = await db
    .select({ job: evalJobs, comparison: evalExperiments, case: evalDatasetCases, current: evalDatasetOutputs })
    .from(evalJobs)
    .innerJoin(evalExperiments, eq(evalExperiments.id, evalJobs.experimentId))
    .innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId))
    .leftJoin(evalDatasetOutputs, and(eq(evalDatasetOutputs.caseId, evalDatasetCases.id), eq(evalDatasetOutputs.datasetId, evalDatasetCases.datasetId)))
    .where(eq(evalJobs.id, jobId));
  if (!row?.job.runId) throw new Error(`comparison job ${jobId} is missing run_id`);

  await db.update(evalJobs).set({ status: "generating", attemptCount: row.job.attemptCount + 1, updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
  try {
    if (!row.current?.parsedOutput || !row.current.schemaValid) throw new Error(`dataset current reading is missing or invalid for case ${row.case.caseKey}`);
    const { value: config } = await getActiveConfig(db, "global");
    const track = row.case.track === "numerology" ? "numerology" : row.case.track;
    const response = await requestGeneration({
      track,
      arm: "candidate",
      model: row.comparison.candidateModel,
      promptVersion: row.case.promptVersion,
      inputSnapshot: row.case.inputSnapshot as Record<string, unknown>,
      requestId: `${row.job.idempotencyKey}:candidate`,
    }, config.retryPolicy);

    await db.insert(evalGenerations).values([
      {
        jobId,
        arm: "baseline",
        executionMode: "cg_standard",
        provider: row.current.provider,
        model: row.current.model,
        promptVersion: row.current.promptVersion,
        parsedOutput: row.current.parsedOutput,
        rawOutput: row.current.rawOutput,
        schemaValid: row.current.schemaValid,
      },
      {
        jobId,
        arm: "candidate",
        executionMode: "cg_standard",
        provider: "cosmic_guidance",
        model: response.model,
        promptVersion: response.promptVersion,
        parsedOutput: response.output,
        rawOutput: response.output,
        schemaValid: response.schemaValid,
        tokensPrompt: response.usage.promptTokens,
        tokensCompletion: response.usage.completionTokens,
        latencyMs: response.latencyMs,
        costUsd: response.costUsd,
        error: response.error,
      },
    ]);
    await db.update(evalJobs).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
    await refreshRunStatus(db, row.job.runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(evalJobs).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
    await refreshRunStatus(db, row.job.runId);
    await logAudit(db, { eventName: "comparison.run.job_failed", actor: "comparison-worker", experimentId: row.comparison.id, jobId, metadata: { runId: row.job.runId, error: message } });
    throw error;
  }
}

async function refreshRunStatus(db: Db, runId: string): Promise<void> {
  const jobs = await db.select({ status: evalJobs.status }).from(evalJobs).where(eq(evalJobs.runId, runId));
  const completedCases = jobs.filter((job) => job.status === "completed").length;
  const failedCases = jobs.filter((job) => job.status === "failed").length;
  const finished = jobs.length > 0 && completedCases + failedCases === jobs.length;
  await db.update(evalComparisonRuns).set({
    status: finished ? (failedCases ? "failed" : "completed") : "running",
    completedCases,
    failedCases,
    ...(finished ? { completedAt: new Date() } : {}),
  }).where(eq(evalComparisonRuns.id, runId));
}
