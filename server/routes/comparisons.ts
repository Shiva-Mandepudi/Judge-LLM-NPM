import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getLimiter } from "../lib/rate-limit.js";
import { db } from "../db.js";
import { getActiveConfig } from "../config/config-service.js";
import { createComparison, createComparisonRun, listComparisonOptions, listComparisons } from "../services/comparison-service.js";

export const comparisonsRouter = Router();

async function rateLimited(_req: Request, res: Response): Promise<boolean> {
  const { value: config } = await getActiveConfig(db, "global");
  const limiter = getLimiter("admin_api", config.rateLimits.maxJudgeCallsPerMinute);
  if (!limiter.tryAcquire()) { res.status(429).json({ error: "rate_limited" }); return true; }
  return false;
}

comparisonsRouter.get("/", async (_req, res) => res.json({ comparisons: await listComparisons(db) }));

comparisonsRouter.get("/options", async (_req, res) => {
  try { res.json(await listComparisonOptions(db)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

comparisonsRouter.post("/", async (req, res) => {
  if (await rateLimited(req, res)) return;
  const parsed = z.object({ name: z.string().trim().min(1).max(200), candidateModel: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid_request", details: parsed.error.message }); return; }
  try {
    const comparison = await createComparison(db, { ...parsed.data, createdBy: req.serviceActor?.subject ?? "unknown" });
    res.status(201).json({ comparison });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

comparisonsRouter.post("/:id/runs", async (req, res) => {
  if (await rateLimited(req, res)) return;
  const parsed = z.object({
    userKeys: z.array(z.string().regex(/^cb-actor-\d{3}$/)).max(100).optional(),
    readingTypes: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    readingSubtypes: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "invalid_request", details: parsed.error.message }); return; }
  try {
    const run = await createComparisonRun(db, { comparisonId: req.params.id, userKeys: parsed.data.userKeys, readingTypes: parsed.data.readingTypes, readingSubtypes: parsed.data.readingSubtypes, createdBy: req.serviceActor?.subject ?? "unknown" });
    res.status(201).json({ run });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
