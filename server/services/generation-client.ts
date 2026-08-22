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

export async function requestGeneration(
  request: GenerationRequest,
  retryPolicy: RetryPolicy,
): Promise<GenerationResponse> {
  const baseUrl = process.env.COSMIC_GUIDANCE_INTERNAL_BASE_URL;
  if (!baseUrl) throw new Error("COSMIC_GUIDANCE_INTERNAL_BASE_URL is not configured.");

  const parsedRequest = generationRequestSchema.parse(request);
  const body = JSON.stringify(parsedRequest);
  const secret = await sharedSecret();

  let lastError: unknown;
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
    const timestamp = Date.now().toString();
    try {
      const res = await fetch(`${baseUrl}/api/internal/judge/generate`, {
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
      return generationResponseSchema.parse(json);
    } catch (err) {
      lastError = err;
      if (err instanceof NonRetryableGenerationError || attempt === retryPolicy.maxAttempts) break;
      const backoff = Math.min(retryPolicy.baseBackoffMs * 2 ** (attempt - 1), retryPolicy.maxBackoffMs);
      logger.warn("generation_retry", { attempt, backoff, error: String(err), requestId: parsedRequest.requestId });
      await sleep(backoff);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

class NonRetryableGenerationError extends Error {}
