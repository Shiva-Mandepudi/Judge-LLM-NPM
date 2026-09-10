import { Router } from "express";
import { z } from "zod";
import { and, count, desc, eq, like } from "drizzle-orm";
import { db } from "../db.js";
import { publishConfigVersion, getActiveConfig } from "../config/config-service.js";
import { judgeConfigSchema } from "../../shared/config-schema.js";
import { registerDataset } from "../services/dataset-service.js";
import { listPendingReviews, resolveReview } from "../services/human-review-service.js";
import { evalAuditLog, evalDatasets, evalDatasetCases, evalDatasetOutputs, evalDatasetSubjects } from "../../shared/schema.js";
import { listProviderModels } from "../services/provider-models-service.js";

export const adminRouter = Router();

adminRouter.post("/provider-models", async (req, res) => {
  const parsed = z.object({ provider: z.enum(["openai", "anthropic", "gemini", "mock", "unset"]), secretRef: z.string().trim().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid_request", details: parsed.error.message }); return; }
  try {
    res.json({ provider: parsed.data.provider, models: await listProviderModels(parsed.data.provider, parsed.data.secretRef) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Read-only lookup used by the 100-user browser to resolve the canonical corpus.
adminRouter.get("/datasets", async (_req, res) => {
  const datasets = await db.select().from(evalDatasets).orderBy(desc(evalDatasets.createdAt));
  const result = await Promise.all(datasets.map(async (dataset) => {
    const [cases, subjects, outputs] = await Promise.all([
      db.select({ promptVersion: evalDatasetCases.promptVersion }).from(evalDatasetCases).where(eq(evalDatasetCases.datasetId, dataset.id)).limit(1),
      db.select({ value: count() }).from(evalDatasetSubjects).where(and(eq(evalDatasetSubjects.datasetId, dataset.id), like(evalDatasetSubjects.subjectKey, "cb-actor-%"))),
      db.select({ value: count() }).from(evalDatasetOutputs).where(eq(evalDatasetOutputs.datasetId, dataset.id)),
    ]);
    return {
      ...dataset,
      promptVersion: cases[0]?.promptVersion ?? null,
      actorUserCount: Number(subjects[0]?.value ?? 0),
      currentReadingCount: Number(outputs[0]?.value ?? 0),
    };
  }));
  res.json({ datasets: result });
});

adminRouter.post("/config", async (req, res) => {
  const schema = z.object({ configKey: z.string().min(1).default("global"), value: judgeConfigSchema });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_config", details: parsed.error.message });
    return;
  }
  const actor = req.serviceActor?.subject ?? "unknown";
  try {
    const supportedProviders = new Set(["openai", "anthropic", "gemini", "mock", "unset"]);
    for (const [role, binding] of Object.entries(parsed.data.value.providers)) {
      if (!supportedProviders.has(binding.provider)) throw new Error(`${role} uses unsupported provider "${binding.provider}".`);
      if (binding.provider === "mock" || binding.provider === "unset") continue;
      const officialModels = await listProviderModels(binding.provider as "openai" | "anthropic" | "gemini", binding.secretRef);
      if (!officialModels.includes(binding.model)) {
        throw new Error(`${role} model "${binding.model}" is not present in ${binding.provider}'s official model catalog.`);
      }
    }
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
