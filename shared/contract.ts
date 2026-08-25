import { z } from "zod";

/**
 * Contract for Cosmic Guidance's internal evaluation-generation interface.
 *
 * This file specifies the endpoint implemented by Cosmic Guidance so the
 * Judge service can request baseline/candidate generations without duplicating
 * prompt builders, schemas, or calculations. No code in this service calls
 * Cosmic Guidance directly except through this contract.
 *
 * Endpoint: POST {COSMIC_GUIDANCE_INTERNAL_BASE_URL}/api/internal/judge/generate
 * Auth: service-to-service HMAC (see server/services/judge/judge-auth.ts)
 *
 * Cosmic Guidance side responsibilities:
 * - Reuse the exact existing prompt builder / schema validator / calculation
 *   service for the given (track, promptVersion) — never a copy.
 * - Run in "evaluation mode": no credit charge, no user/profile creation, no
 *   subscription mutation, no write to user-facing tables (readings/
 *   conversations/my_day caches). Purely an in-memory generate-and-return.
 * - Never require or return PII, auth tokens, encrypted vault fields, or
 *   unnecessary user identifiers — inputSnapshot is already de-identified.
 * - Return deterministic calculation outputs verbatim from its own
 *   calculators when calcInputs are provided, rather than the Judge
 *   service inventing/recomputing astrology or numerology values.
 */

export const evalArmSchema = z.enum(["baseline", "candidate"]);
export type EvalArm = z.infer<typeof evalArmSchema>;

export const generationRequestSchema = z.object({
  track: z.string(),
  arm: evalArmSchema,
  model: z.string(),
  promptVersion: z.string(),
  // Opaque, de-identified snapshot of exactly what the real prompt builder
  // needs (chart JSON, numerology number, tarot draw, conversation turns,
  // etc.) plus any deterministic-calc inputs needed to reproduce calc
  // outputs via Cosmic Guidance's own calculators.
  inputSnapshot: z.record(z.unknown()),
  requestId: z.string(), // == eval_jobs.idempotency_key, for CG-side idempotency/logging
});
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export const generationResponseSchema = z.object({
  requestId: z.string(),
  track: z.string(),
  arm: evalArmSchema,
  model: z.string(),
  promptVersion: z.string(),
  // Parsed output matching the track's existing production schema
  // (e.g. myDayInsightsResponseSchema) — validated on the CG side using the
  // real validator, then passed through unchanged.
  output: z.record(z.unknown()),
  schemaValid: z.boolean(),
  schemaErrors: z.array(z.string()).default([]),
  // Deterministic calculation outputs, verbatim from CG's own calculators,
  // when the track needs them for grounding checks (e.g. numerology number
  // meaning, chart aspects). Absent for tracks with no calc dependency.
  calcOutputs: z.record(z.unknown()).nullable().default(null),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedPromptTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningTokens: z.number().int().nonnegative().nullable().optional(),
    acceptedPredictionTokens: z.number().int().nonnegative().nullable().optional(),
    rejectedPredictionTokens: z.number().int().nonnegative().nullable().optional(),
  }),
  latencyMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable().default(null),
  requestArtifact: z.object({
    endpoint: z.string().min(1),
    requestBody: z.record(z.unknown()),
    responseText: z.string(),
    usage: z.record(z.unknown()),
    providerMetadata: z.record(z.unknown()),
    latencyMs: z.number().int().nonnegative(),
    requestLogId: z.string(),
    systemPromptTokens: z.number().int().nonnegative(),
    userPromptTokens: z.number().int().nonnegative(),
    assistantContextTokens: z.number().int().nonnegative(),
    promptCharacterCount: z.number().int().nonnegative(),
    systemPromptHash: z.string().nullable(),
    userPromptHash: z.string().nullable(),
  }).nullable().optional(),
});
export type GenerationResponse = z.infer<typeof generationResponseSchema>;

/** Batch-vs-live equivalence track sends the same request shape twice with different `arm` semantics (arm = "batch" | "live"), reusing the same schema with arm relabeled by the caller before scoring. */
export const BATCH_VS_LIVE_ARMS = ["batch_path", "live_path"] as const;
