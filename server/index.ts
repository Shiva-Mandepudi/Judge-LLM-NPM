import "dotenv/config";
import express from "express";
import path from "node:path";
import { healthRouter } from "./routes/health.js";
import { comparisonsRouter } from "./routes/comparisons.js";
import { runsRouter } from "./routes/runs.js";
import { adminRouter } from "./routes/admin.js";
import { datasetBrowserRouter } from "./routes/dataset-browser.js";
import { pricingRouter } from "./routes/pricing.js";
import { costsRouter } from "./routes/costs.js";
import { workerRouter } from "./routes/worker.js";
import { requireAdminServiceAuth } from "./auth/service-auth.js";
import { logger } from "./lib/logger.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// Health/ready are unauthenticated for Cloud Run's own probes.
app.use(healthRouter);

app.get("/", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "admin-dashboard/landing.html"));
});

// Read-only static admin dashboard (calls the authenticated JSON API itself).
app.use("/admin/dashboard", express.static(path.resolve(process.cwd(), "admin-dashboard")));

// Everything under /api/admin requires the admin shared secret. This is the
// ONLY inbound API this service exposes for experiment/config/review
// management — there is no unauthenticated surface besides /health and /ready.
app.use("/api/admin", requireAdminServiceAuth());
app.use("/api/admin/comparisons", comparisonsRouter);
app.use("/api/admin/runs", runsRouter);
app.use("/api/admin/dataset-browser", datasetBrowserRouter);
app.use("/api/admin/pricing", pricingRouter);
app.use("/api/admin/costs", costsRouter);
app.use("/api/admin", adminRouter);

// Cloud Tasks push target — guarded by OIDC verification inside the router, not a shared secret.
app.use("/internal/worker", workerRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT ?? 8081);
app.listen(port, () => {
  logger.info("judge_service_listening", { port });
});
