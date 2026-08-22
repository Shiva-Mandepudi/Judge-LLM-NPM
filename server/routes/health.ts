import { Router } from "express";
import { pool } from "../db.js";

export const healthRouter = Router();

// Liveness: process is up, no dependency check (mirrors Cosmic Guidance's /health).
healthRouter.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// Readiness: can actually serve traffic (DB reachable).
healthRouter.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not_ready", error: err instanceof Error ? err.message : String(err) });
  }
});
