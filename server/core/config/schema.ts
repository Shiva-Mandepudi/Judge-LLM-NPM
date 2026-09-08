import { z } from "zod";

// Shapes copied exactly from
// docs/LLM PLAN/03-build-plan/00-architecture-and-parametrization.md#the-four-config-artifacts
// per docs/REBUILD-PLAN.md §7 — do not redesign these, only validate them strictly.

export const modelRefSchema = z.object({ modelId: z.string().min(1), label: z.string().optional() });

export const modelsConfigSchema = z.object({
  champion: modelRefSchema,
  challengers: z.array(z.object({ modelId: z.string().min(1) })),
  includeSilverAsBlindArm: z.boolean(),
  judge: z.object({
    primary: z.object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
      effort: z.string().min(1),
      thinking: z.string().min(1),
    }),
    secondary: z.object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
      sampleRate: z.number().min(0).max(1),
    }),
  }),
  rates: z.record(
    z.string(),
    z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() })
  ),
});
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;

export const thresholdsConfigSchema = z.object({
  composite: z.object({ // core-vocab-ok: composite quality score, not the astrology composite-chart reading type
    weights: z.record(z.string(), z.number()),
    requireAllScored: z.boolean(),
  }),
  gates: z.object({ maxFailureRateUpperBound: z.number().min(0).max(1) }),
  decision: z.object({
    qualityMarginDelta: z.number(),
    maxDegenerateRate: z.number().min(0).max(1),
  }),
  statistics: z.object({
    bootstrapIterations: z.number().int().positive(),
    confidenceLevel: z.number().min(0).max(1),
    clusterBy: z.string().min(1),
    multiplicityCorrection: z.string().min(1),
  }),
  judgeReliability: z.object({
    rejudgeSampleRate: z.number().min(0).max(1),
    minSelfAgreementWithinOne: z.number().min(0).max(1),
    minCrossJudgeAgreementWithinOne: z.number().min(0).max(1),
  }),
});
export type ThresholdsConfig = z.infer<typeof thresholdsConfigSchema>;

export const runConfigSchema = z.object({
  runId: z.string().min(1),
  users: z.number().int().positive(),
  tracks: z.array(z.string()),
  models: z.object({ fromModelsYaml: z.boolean() }),
  prompt: z.object({
    includeSilverReference: z.boolean(),
    cacheBreakpointAfter: z.string().min(1),
  }),
  execution: z.object({
    mode: z.enum(["batch", "interactive"]),
    shardBy: z.string().min(1),
    maxConcurrentShards: z.number().int().positive(),
    resume: z.boolean(),
  }),
  stages: z.array(z.string()),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

// Schema: docs/LLM PLAN/03-build-plan/00-architecture-and-parametrization.md#configtracksltrackgtyaml
// `status`/`blockedReason` are this repo's addition, not in the plan's example — they
// make a track's §1.5 blocker visible in the config itself instead of only in
// config/blockers.yaml, so a loader can filter blocked tracks without cross-referencing
// two files by hand. `status: "blocked"` must match an open blocker in blockers.yaml;
// see server/core/config/loader.ts#loadTrackSpecs.
export const trackSpecSchema = z.object({
  track: z.string().min(1),
  label: z.string().min(1),
  purpose: z.string().min(1),
  depth: z.enum(["brief", "detailed"]).optional(),
  status: z.enum(["active", "blocked"]),
  blockedReason: z.string().min(1).optional(),
  datasource: z
    .object({
      silver: z.object({ table: z.string().min(1), outputColumn: z.string().min(1).optional(), userKey: z.string().min(1) }).optional(),
      challenger: z.object({ source: z.string().min(1) }),
      input: z.object({ table: z.string().min(1), columns: z.array(z.string().min(1)) }).optional(),
    })
    .optional(),
  renderer: z.string().min(1),
  strata: z.array(z.string().min(1)),
  rowsPerUser: z.number().int().positive(),
  prompt: z.object({ rubricPack: z.string().min(1) }),
  sampling: z.object({ mode: z.enum(["exhaustive", "stratified"]) }),
}).refine((t) => t.status === "active" || !!t.blockedReason, {
  message: "blocked tracks must state blockedReason",
});
export type TrackSpec = z.infer<typeof trackSpecSchema>;

export const blockerSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["open", "closed"]),
  blocks: z.array(z.string().min(1)),
  reason: z.string().min(1),
});
export const blockersConfigSchema = z.object({ blockers: z.array(blockerSchema) });
export type BlockersConfig = z.infer<typeof blockersConfigSchema>;
export type Blocker = z.infer<typeof blockerSchema>;
