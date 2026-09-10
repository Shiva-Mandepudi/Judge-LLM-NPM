import { Router } from "express";
import { db } from "../db.js";
import { estimateRunCost, getRunCostAnalysis } from "../services/cost-service.js";

export const costsRouter = Router();

// All cost totals are computed server-side by cost-service; these routes only
// project the authoritative analysis into per-reading/per-user slices.
// Money values stay nullable end-to-end — unknown is never reported as $0.

const statusFor = (message: string) => (message.includes("not found") ? 404 : 400);

const parseList = (value: unknown): string[] | undefined =>
  typeof value === "string" && value.trim() ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;

costsRouter.get("/runs/:runId", async (req, res) => {
  try {
    res.json(await getRunCostAnalysis(db, req.params.runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(statusFor(message)).json({ error: message });
  }
});

costsRouter.get("/runs/:runId/readings", async (req, res) => {
  try {
    const analysis = await getRunCostAnalysis(db, req.params.runId);
    res.json({ runId: analysis.runId, currency: analysis.currency, status: analysis.status, byReading: analysis.byReading, warnings: analysis.warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(statusFor(message)).json({ error: message });
  }
});

costsRouter.get("/runs/:runId/users", async (req, res) => {
  try {
    const analysis = await getRunCostAnalysis(db, req.params.runId);
    res.json({ runId: analysis.runId, currency: analysis.currency, status: analysis.status, byUser: analysis.byUser, warnings: analysis.warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(statusFor(message)).json({ error: message });
  }
});

// No-call pre-run estimate. Resolves the exact case set a run would execute
// and prices observed token envelopes against the latest valid snapshot — it
// never calls a provider.
costsRouter.get("/estimate", async (req, res) => {
  const comparisonId = req.query.comparisonId;
  if (typeof comparisonId !== "string" || !comparisonId.trim()) {
    res.status(400).json({ error: "invalid_request", details: "comparisonId query parameter is required" });
    return;
  }
  try {
    res.json(
      await estimateRunCost(db, {
        comparisonId: comparisonId.trim(),
        userKeys: parseList(req.query.userKeys),
        readingTypes: parseList(req.query.readingTypes),
        readingSubtypes: parseList(req.query.readingSubtypes),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(statusFor(message)).json({ error: message });
  }
});
