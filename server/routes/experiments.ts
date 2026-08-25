import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { evalExperiments, evalResultsSummaries, evalTracks, evalJobs, evalGenerations, evalJudgeScores } from "../../shared/schema.js";
import { createExperiment, enqueueExperimentJobs, retryFailedJobs } from "../services/experiment-service.js";
import { computeAndPersistResults } from "../services/results-service.js";
import { buildExperimentReport } from "../services/report-service.js";
import { getLimiter } from "../lib/rate-limit.js";
import { getActiveConfig } from "../config/config-service.js";

export const experimentsRouter = Router();

const createExperimentSchema = z.object({
  name: z.string().min(1),
  track: z.enum(evalTracks),
  datasetId: z.string().uuid(),
  baselineModel: z.string().min(1).default("dataset-ground-truth"),
  candidateModel: z.string().min(1),
  baselinePromptVersion: z.string().min(1).default("dataset-ground-truth"),
  candidatePromptVersion: z.string().min(1),
  comparisonType: z.enum(["model", "execution_mode", "ground_truth"]).default("ground_truth"),
  referenceRunId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.comparisonType !== "ground_truth" && value.baselineModel === "dataset-ground-truth") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineModel"], message: "baselineModel is required for model comparisons" });
  }
});

async function rateLimited(_req: Request, res: Response): Promise<boolean> {
  const { value: config } = await getActiveConfig(db, "global");
  const limiter = getLimiter("admin_api", config.rateLimits.maxJudgeCallsPerMinute);
  if (!limiter.tryAcquire()) {
    res.status(429).json({ error: "rate_limited" });
    return true;
  }
  return false;
}

experimentsRouter.post("/", async (req, res) => {
  if (await rateLimited(req, res)) return;
  const parsed = createExperimentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.message });
    return;
  }
  const actor = req.serviceActor?.subject ?? "unknown";
  const experiment = await createExperiment(db, { ...parsed.data, createdBy: actor });
  res.status(201).json(experiment);
});

experimentsRouter.get("/", async (_req, res) => {
  const rows = await db.select().from(evalExperiments).orderBy(evalExperiments.createdAt);
  res.json({ experiments: rows });
});

experimentsRouter.get("/:id", async (req, res) => {
  const [row] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, req.params.id));
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ experiment: row });
});

experimentsRouter.post("/:id/enqueue", async (req, res) => {
  if (await rateLimited(req, res)) return;
  try {
    const result = await enqueueExperimentJobs(db, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

experimentsRouter.post("/:id/retry-failed", async (req, res) => {
  if (await rateLimited(req, res)) return;
  const actor = req.serviceActor?.subject ?? "unknown";
  try {
    const result = await retryFailedJobs(db, req.params.id, actor);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

experimentsRouter.post("/:id/compute-results", async (req, res) => {
  const actor = req.serviceActor?.subject ?? "unknown";
  try {
    const summary = await computeAndPersistResults(db, req.params.id, actor);
    res.json({ summary });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

experimentsRouter.get("/:id/results", async (req, res) => {
  const rows = await db
    .select()
    .from(evalResultsSummaries)
    .where(eq(evalResultsSummaries.experimentId, req.params.id))
    .orderBy(evalResultsSummaries.computedAt);
  res.json({ results: rows });
});

// Per-job generation evidence — the results summary above only has the
// aggregate. This is the drill-down view for the exact model output and
// validation state without a direct DB query.
experimentsRouter.get("/:id/generations", async (req, res) => {
  const jobs = await db.select().from(evalJobs).where(eq(evalJobs.experimentId, req.params.id)).orderBy(evalJobs.createdAt);
  const jobIds = jobs.map((j) => j.id);
  if (jobIds.length === 0) {
    res.json({ jobs: [] });
    return;
  }

  const generations = await db.select().from(evalGenerations).where(inArray(evalGenerations.jobId, jobIds));
  const judgeScores = await db.select().from(evalJudgeScores).where(inArray(evalJudgeScores.jobId, jobIds));

  const result = jobs.map((job) => ({
    jobId: job.id,
    status: job.status,
    attemptCount: job.attemptCount,
    lastError: job.lastError,
    generations: generations
      .filter((g) => g.jobId === job.id)
      .map((g) => ({
        arm: g.arm,
        provider: g.provider,
        model: g.model,
        schemaValid: g.schemaValid,
        output: g.parsedOutput,
        tokensPrompt: g.tokensPrompt,
        tokensCompletion: g.tokensCompletion,
        latencyMs: g.latencyMs,
        error: g.error,
      })),
    judgeScores: judgeScores
      .filter((s) => s.jobId === job.id)
      .map((s) => ({
        judgeRole: s.judgeRole,
        provider: s.provider,
        model: s.model,
        pairwiseWinner: s.pairwiseWinner,
        confidenceLevel: s.confidenceLevel,
        latencyMs: s.latencyMs,
      })),
  }));

  res.json({ jobs: result });
});

// Full human-readable report: which prompt/dataset case each job checked,
// what CG's baseline/candidate models were, what other models have been
// tried on this same track, hard-gate results, judge rationale, and the
// pass/fail recommendation with its reasons.
experimentsRouter.get("/:id/report", async (req, res) => {
  try {
    const report = await buildExperimentReport(db, req.params.id);
    res.json(report);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
