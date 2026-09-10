import { Router } from "express";
import { db } from "../db.js";
import { analyzeComparisonRun, cancelComparisonRun, listComparisonRuns } from "../services/comparison-service.js";
import { buildComparisonRunReport } from "../services/comparison-run-report.js";

export const runsRouter = Router();

runsRouter.get("/", async (_req, res) => res.json({ runs: await listComparisonRuns(db) }));

runsRouter.post("/:id/cancel", async (req, res) => {
  try {
    const run = await cancelComparisonRun(db, { runId: req.params.id, actor: req.serviceActor?.subject ?? "unknown" });
    res.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.endsWith("not found") ? 404 : 409).json({ error: message });
  }
});

runsRouter.post("/:id/analyze", async (req, res) => {
  try {
    const result = await analyzeComparisonRun(db, { runId: req.params.id, actor: req.serviceActor?.subject ?? "unknown" });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.endsWith("not found") ? 404 : 400).json({ error: message });
  }
});

runsRouter.get("/:id", async (req, res) => {
  try { res.json({ report: await buildComparisonRunReport(db, req.params.id) }); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : String(error) }); }
});

runsRouter.get("/:id/report", async (req, res) => {
  try { res.json(await buildComparisonRunReport(db, req.params.id)); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : String(error) }); }
});
