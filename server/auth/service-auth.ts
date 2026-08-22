import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { resolveSecret } from "../lib/secrets.js";
import { logger } from "../lib/logger.js";

declare module "express-serve-static-core" {
  interface Request {
    serviceActor?: { kind: "admin_console" | "cloud_tasks"; subject: string };
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Guards the admin/experiment-management API. Cosmic Guidance's admin panel
 * (or an operator's CLI) authenticates with a shared secret issued via
 * Secret Manager — this is a machine credential, not a user session; it
 * never carries a Cosmic Guidance user identity into the Judge service.
 */
export function requireAdminServiceAuth() {
  const secretRef = process.env.JUDGE_ADMIN_SHARED_SECRET_REF;
  if (!secretRef) {
    throw new Error("JUDGE_ADMIN_SHARED_SECRET_REF must be configured before the admin API can start.");
  }
  let cachedSecret: string | undefined;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      cachedSecret ??= await resolveSecret(secretRef);
      const provided = req.header("x-judge-admin-secret") ?? "";
      if (!provided || !timingSafeEqualStrings(provided, cachedSecret)) {
        logger.warn("admin_auth_denied", { path: req.path, ip: req.ip });
        res.status(403).json({ error: "forbidden" });
        return;
      }
      req.serviceActor = { kind: "admin_console", subject: req.header("x-judge-actor") ?? "unknown" };
      next();
    } catch (err) {
      logger.error("admin_auth_error", { error: String(err) });
      res.status(503).json({ error: "auth_unavailable" });
    }
  };
}

/**
 * Guards the Cloud Tasks push-worker endpoint. Verifies the Google-signed
 * OIDC identity token Cloud Tasks attaches to every push request, checking
 * both signature/issuer and audience (must equal this worker's own URL) so
 * an unrelated Cloud Run service's tasks can't invoke it.
 */
export function requireCloudTasksAuth() {
  const audience = process.env.JUDGE_WORKER_OIDC_AUDIENCE;
  const expectedServiceAccount = process.env.CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT;
  if (!audience) {
    // ponytail: local dev runs jobs inline (LOCAL_INLINE_WORKER=true) and never
    // hits this push endpoint, so don't fail startup for a Cloud Tasks-only var.
    return async (_req: Request, res: Response) => {
      res.status(503).json({ error: "cloud_tasks_worker_not_configured" });
    };
  }
  const client = new OAuth2Client();

  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    try {
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      if (!payload?.email || (expectedServiceAccount && payload.email !== expectedServiceAccount)) {
        logger.warn("worker_auth_wrong_service_account", { email: payload?.email });
        res.status(403).json({ error: "forbidden" });
        return;
      }
      req.serviceActor = { kind: "cloud_tasks", subject: payload.email };
      next();
    } catch (err) {
      logger.warn("worker_auth_invalid_token", { error: String(err) });
      res.status(401).json({ error: "invalid_token" });
    }
  };
}
