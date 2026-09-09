import { Router } from "express";
import { db } from "../db.js";
import { listComparisonRuns } from "../services/comparison-service.js";
import { buildComparisonRunReport } from "../services/comparison-run-report.js";

export const runsRouter = Router();

runsRouter.get("/", async (_req, res) => res.json({ runs: await listComparisonRuns(db) }));

runsRouter.get("/:id", async (req, res) => {
  try { res.json({ report: await buildComparisonRunReport(db, req.params.id) }); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : String(error) }); }
});

runsRouter.get("/:id/report", async (req, res) => {
  try { res.json(await buildComparisonRunReport(db, req.params.id)); }
  catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : String(error) }); }
});
