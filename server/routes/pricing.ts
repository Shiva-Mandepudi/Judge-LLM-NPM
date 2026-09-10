import path from "node:path";
import { readFileSync } from "node:fs";
import { Router } from "express";
import { parse as parseYaml } from "yaml";
import { db } from "../db.js";
import {
  createDrizzlePricingStore,
  getPricingStatus,
  getSnapshot,
  syncOfficialPrices,
} from "../services/pricing-service.js";

export const pricingRouter = Router();

const store = createDrizzlePricingStore(db);

// Syncs the curated catalog (config/pricing-catalog.yaml) into an immutable DB
// snapshot. Idempotent: an unchanged catalog hash returns the existing valid
// snapshot instead of inserting duplicate rates. A catalog that fails
// validation records a 'failed' snapshot and leaves the previous valid one
// untouched — the response carries the full issue list so it can be fixed in
// one pass.
pricingRouter.post("/sync", async (req, res) => {
  try {
    const configDir = path.resolve(process.cwd(), "config");
    const rawCatalog = parseYaml(readFileSync(path.join(configDir, "pricing-catalog.yaml"), "utf8"));
    const result = await syncOfficialPrices(store, {
      rawCatalog,
      triggeredBy: req.serviceActor?.subject ?? "unknown",
    });
    if (result.status === "failed") {
      res.status(400).json({ status: "failed", snapshotId: result.snapshotId, errors: result.errors });
      return;
    }
    res.status(result.status === "synced" ? 201 : 200).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

pricingRouter.get("/status", async (_req, res) => {
  try {
    res.json(await getPricingStatus(store));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

pricingRouter.get("/snapshots/:snapshotId", async (req, res) => {
  try {
    const result = await getSnapshot(store, req.params.snapshotId);
    if (!result) {
      res.status(404).json({ error: "pricing snapshot not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
