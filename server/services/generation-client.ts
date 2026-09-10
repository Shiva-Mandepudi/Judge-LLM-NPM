import crypto from "node:crypto";
import { resolveSecret } from "../lib/secrets.js";
import { logger } from "../lib/logger.js";
import {
  generationRequestSchema,
  generationResponseSchema,
  type GenerationRequest,
  type GenerationResponse,
} from "../../shared/contract.js";
import type { RetryPolicy } from "../../shared/config-schema.js";

/**
 * The ONLY place this service talks to Cosmic Guidance. Calls the internal
 * evaluation-generation interface (contract in shared/contract.ts) so
 * baseline and candidate generations reuse CG's real prompt builders,
 * schemas, and calculators — this service never re-implements any of them.
 */

let cachedSecret: string | undefined;

async function sharedSecret(): Promise<string> {
  const ref = process.env.JUDGE_TO_CG_SHARED_SECRET_REF;
  if (!ref) throw new Error("JUDGE_TO_CG_SHARED_SECRET_REF is not configured.");
  cachedSecret ??= await resolveSecret(ref);
  return cachedSecret;
}

function signBody(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function describeTransportError(error: unknown, baseUrl: string): string {
  if (!(error instanceof TypeError)) return error instanceof Error ? error.message : String(error);
  const cause = (error as TypeError & { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return `Cosmic Guidance is unreachable at ${baseUrl}${detail ? ` (${detail})` : ""}`;
}

export interface GenerationAttemptEvent {
  attempt: number;
  requestId: string;
  model: string;
  endpoint: string;
  startedAt: Date;
  completedAt: Date;
  latencyMs: number;
  status: "succeeded" | "failed";
  response?: GenerationResponse;
  error?: string;
}

export async function requestGeneration(
  request: GenerationRequest,
  retryPolicy: RetryPolicy,
  options: { onAttemptStart?: (event: { attempt: number; requestId: string; model: string; endpoint: string; startedAt: Date }) => Promise<unknown>; onAttempt?: (event: GenerationAttemptEvent, context?: unknown) => Promise<void> } = {},
): Promise<GenerationResponse> {
  const baseUrl = process.env.COSMIC_GUIDANCE_INTERNAL_BASE_URL;
  if (!baseUrl) throw new Error("COSMIC_GUIDANCE_INTERNAL_BASE_URL is not configured.");

  const parsedRequest = generationRequestSchema.parse(request);
  const body = JSON.stringify(parsedRequest);
  const secret = await sharedSecret();

  let lastError: unknown;
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const timestamp = Date.now().toString();
    const endpoint = `${baseUrl}/api/internal/judge/generate`;
    let attemptContext: unknown;
    try {
      attemptContext = await options.onAttemptStart?.({ attempt, requestId: parsedRequest.requestId, model: parsedRequest.model, endpoint, startedAt });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-judge-timestamp": timestamp,
          "x-judge-signature": signBody(secret, timestamp, body),
          "x-judge-request-id": parsedRequest.requestId,
        },
        body,
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`generation endpoint returned ${res.status}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new NonRetryableGenerationError(`generation endpoint returned ${res.status}: ${text}`);
      }

      const json = await res.json();
      const response = generationResponseSchema.parse(json);
      try {
        await options.onAttempt?.({
          attempt,
          requestId: parsedRequest.requestId,
          model: response.model,
          endpoint,
          startedAt,
          completedAt: new Date(),
          latencyMs: Date.now() - startedMs,
          status: "succeeded",
          response,
        }, attemptContext);
      } catch (error) {
        throw new TelemetryCaptureError(error instanceof Error ? error.message : String(error));
      }
      return response;
    } catch (err) {
      if (err instanceof TelemetryCaptureError) throw err;
      const message = describeTransportError(err, baseUrl);
      lastError = new Error(message);
      try {
        await options.onAttempt?.({
          attempt,
          requestId: parsedRequest.requestId,
          model: parsedRequest.model,
          endpoint,
          startedAt,
          completedAt: new Date(),
          latencyMs: Date.now() - startedMs,
          status: "failed",
          error: message,
        }, attemptContext);
      } catch (error) {
        throw new TelemetryCaptureError(error instanceof Error ? error.message : String(error));
      }
      if (err instanceof NonRetryableGenerationError || attempt === retryPolicy.maxAttempts) break;
      const backoff = Math.min(retryPolicy.baseBackoffMs * 2 ** (attempt - 1), retryPolicy.maxBackoffMs);
      logger.warn("generation_retry", { attempt, backoff, error: message, requestId: parsedRequest.requestId });
      await sleep(backoff);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

class NonRetryableGenerationError extends Error {}
class TelemetryCaptureError extends Error {}
