import { Router } from "express";
import { z } from "zod";
import { desc } from "drizzle-orm";
import { db } from "../db.js";
import { publishConfigVersion, getActiveConfig } from "../config/config-service.js";
import { judgeConfigSchema } from "../../shared/config-schema.js";
import { registerDataset } from "../services/dataset-service.js";
import { listPendingReviews, resolveReview } from "../services/human-review-service.js";
import { evalAuditLog } from "../../shared/schema.js";

export const adminRouter = Router();

adminRouter.post("/config", async (req, res) => {
  const schema = z.object({ configKey: z.string().min(1).default("global"), value: judgeConfigSchema });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_config", details: parsed.error.message });
    return;
  }
  const actor = req.serviceActor?.subject ?? "unknown";
  try {
    const result = await publishConfigVersion(db, { configKey: parsed.data.configKey, value: parsed.data.value, createdBy: actor });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: "config_rejected", details: err instanceof Error ? err.message : String(err) });
  }
});

adminRouter.get("/config/:key", async (req, res) => {
  try {
    const active = await getActiveConfig(db, req.params.key);
    res.json(active);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

adminRouter.post("/datasets/register", async (req, res) => {
  const schema = z.object({ track: z.string().min(1), version: z.string().min(1), description: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.message });
    return;
  }
  const actor = req.serviceActor?.subject ?? "unknown";
  try {
    const result = await registerDataset(db, { ...parsed.data, createdBy: actor });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

adminRouter.get("/human-review", async (_req, res) => {
  const reviews = await listPendingReviews(db);
  res.json({ reviews });
});

adminRouter.post("/human-review/:id/resolve", async (req, res) => {
  const schema = z.object({ decision: z.enum(["confirm_fail", "overturn_pass", "needs_more_data"]), notes: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.message });
    return;
  }
  const actor = req.serviceActor?.subject ?? "unknown";
  await resolveReview(db, { reviewId: req.params.id, resolvedBy: actor, decision: parsed.data.decision, notes: parsed.data.notes });
  res.json({ ok: true });
});

adminRouter.get("/audit-log", async (_req, res) => {
  const rows = await db.select().from(evalAuditLog).orderBy(desc(evalAuditLog.createdAt)).limit(200);
  res.json({ auditLog: rows });
});
