import { z } from "zod";

// Everything an operator can tune without a code deploy. Stored versioned in
// eval_config_versions, activated via the admin API. Nothing in this shape is
// ever hardcoded in service code — models, thresholds, sample rates, and
// provider choice are all read from the active config row at call time.

export const judgeProviderRoleSchema = z.enum(["primary_judge", "secondary_judge", "generation_baseline", "generation_candidate"]);

export const providerBindingSchema = z.object({
  provider: z.string().min(1), // "anthropic" | "openai" | "gemini" | "mock" | future vendors — not an enum, so new vendors don't need a schema migration
  model: z.string().min(1),
  secretRef: z.string().min(1), // Secret Manager secret id (or env var name in local dev), never the raw key
});
export type ProviderBinding = z.infer<typeof providerBindingSchema>;

export const acceptanceThresholdsSchema = z.object({
  maxSoftDimensionDegradation: z.number().default(0.3),
  minWinPlusTieRate: z.number().min(0).max(1).default(0.6),
  minJudgeAgreementRate: z.number().min(0).max(1).default(0.7),
  hardGateTolerance: z.literal(0).default(0), // zero tolerance, fixed by design; kept as config so it's auditable, not implicit
});
export type AcceptanceThresholds = z.infer<typeof acceptanceThresholdsSchema>;

export const rateLimitSchema = z.object({
  maxConcurrentJobsPerExperiment: z.number().int().positive().default(10),
  maxJudgeCallsPerMinute: z.number().int().positive().default(60),
  maxGenerationCallsPerMinute: z.number().int().positive().default(60),
});

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(5),
  baseBackoffMs: z.number().int().positive().default(2000),
  maxBackoffMs: z.number().int().positive().default(60_000),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const judgeConfigSchema = z.object({
  providers: z.object({
    primary_judge: providerBindingSchema,
    secondary_judge: providerBindingSchema,
  }),
  secondaryJudgeSampleRate: z.number().min(0).max(1).default(0.2),
  thresholds: acceptanceThresholdsSchema.default({}),
  rateLimits: rateLimitSchema.default({}),
  retryPolicy: retryPolicySchema.default({}),
  humanReviewTriggers: z.object({
    onHardGateFailure: z.boolean().default(true),
    onJudgeDisagreement: z.boolean().default(true),
    onLowConfidence: z.boolean().default(true),
    onBorderlineNonInferiority: z.boolean().default(true),
    borderlineBandWidth: z.number().min(0).default(0.05), // how close to the threshold counts as "borderline"
  }).default({}),
});
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = judgeConfigSchema.parse({
  providers: {
    primary_judge: { provider: "unset", model: "unset", secretRef: "unset" },
    secondary_judge: { provider: "unset", model: "unset", secretRef: "unset" },
  },
});
