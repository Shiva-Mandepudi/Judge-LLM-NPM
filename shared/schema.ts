import { pgTable, text, uuid, integer, boolean, jsonb, timestamp, real, unique } from "drizzle-orm/pg-core";

// All tables live in the Judge service's own database/schema. Nothing here is
// ever written to Cosmic Guidance's product DB, and nothing here references
// a Cosmic Guidance user/profile/subscription/credit row by foreign key —
// only opaque case identifiers and de-identified input snapshots.

export const evalTracks = [
  "my_day_model_comparison",
  "my_day_batch_vs_live",
  "numerology",
  "brief_readings",
  "ai_chat",
  "safety_injection",
] as const;
export type EvalTrack = (typeof evalTracks)[number];

export const evalDatasets = pgTable("eval_datasets", {
  id: uuid("id").primaryKey().defaultRandom(),
  track: text("track").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  sourceChecksum: text("source_checksum").notNull(),
  caseCount: integer("case_count").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  trackVersionUnique: unique().on(t.track, t.version),
}));

export const evalDatasetCases = pgTable("eval_dataset_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  caseKey: text("case_key").notNull(),
  track: text("track").notNull(),
  // Input snapshot: de-identified generation inputs (birth data already
  // reduced to calc outputs, no names/emails/raw PII). Includes the exact
  // deterministic calculation outputs sourced from Cosmic Guidance's own
  // calculators via the internal evaluation-generation interface, never
  // recomputed/invented by the Judge service.
  inputSnapshot: jsonb("input_snapshot").notNull(),
  promptVersion: text("prompt_version").notNull(),
  tags: jsonb("tags").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  datasetCaseUnique: unique().on(t.datasetId, t.caseKey),
}));

export const experimentStatuses = ["draft", "running", "completed", "failed", "canceled"] as const;
export type ExperimentStatus = (typeof experimentStatuses)[number];

export const evalExperiments = pgTable("eval_experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  track: text("track").notNull(),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  baselineModel: text("baseline_model").notNull(),
  candidateModel: text("candidate_model").notNull(),
  baselinePromptVersion: text("baseline_prompt_version").notNull(),
  candidatePromptVersion: text("candidate_prompt_version").notNull(),
  configVersionId: uuid("config_version_id").notNull().references(() => evalConfigVersions.id),
  secondaryJudgeSampleRate: real("secondary_judge_sample_rate").notNull().default(0.2),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobStatuses = ["pending", "generating", "checking", "judging", "completed", "failed"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const evalJobs = pgTable("eval_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentId: uuid("experiment_id").notNull().references(() => evalExperiments.id),
  caseId: uuid("case_id").notNull().references(() => evalDatasetCases.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  blindLabelMap: jsonb("blind_label_map").$type<{ A: "baseline" | "candidate"; B: "baseline" | "candidate" }>(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const evalGenerations = pgTable("eval_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  arm: text("arm").notNull(), // baseline | candidate
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  rawOutput: jsonb("raw_output"),
  parsedOutput: jsonb("parsed_output"),
  schemaValid: boolean("schema_valid").notNull().default(false),
  tokensPrompt: integer("tokens_prompt"),
  tokensCompletion: integer("tokens_completion"),
  latencyMs: integer("latency_ms"),
  costUsd: real("cost_usd"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalDeterministicResults = pgTable("eval_deterministic_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  arm: text("arm").notNull(),
  checkName: text("check_name").notNull(),
  passed: boolean("passed").notNull(),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalJudgeScores = pgTable("eval_judge_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  judgeRole: text("judge_role").notNull(), // primary | secondary
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  dimensionScores: jsonb("dimension_scores").notNull(), // { dimension: { score, justification } }
  hardGateResults: jsonb("hard_gate_results").notNull(), // { dimension: { pass, violationDetail } }
  pairwiseWinner: text("pairwise_winner"), // A | B | Tie | null for single-arm
  rationale: text("rationale"),
  confidenceLevel: text("confidence_level"),
  rawResponse: jsonb("raw_response"),
  latencyMs: integer("latency_ms"),
  costUsd: real("cost_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalHumanReviewQueue = pgTable("eval_human_review_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  experimentId: uuid("experiment_id").notNull().references(() => evalExperiments.id),
  reason: text("reason").notNull(), // hard_gate_failure | judge_disagreement | borderline | low_confidence
  status: text("status").notNull().default("pending"), // pending | resolved
  assignedTo: text("assigned_to"),
  resolutionNotes: text("resolution_notes"),
  resolutionDecision: text("resolution_decision"), // confirm_fail | overturn_pass | needs_more_data
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalResultsSummaries = pgTable("eval_results_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentId: uuid("experiment_id").notNull().references(() => evalExperiments.id),
  sampleSize: integer("sample_size").notNull(),
  meanDimensionScores: jsonb("mean_dimension_scores").notNull(),
  dimensionDeltas: jsonb("dimension_deltas").notNull(),
  winRate: real("win_rate"),
  tieRate: real("tie_rate"),
  lossRate: real("loss_rate"),
  hardGateFailureCount: integer("hard_gate_failure_count").notNull().default(0),
  judgeAgreementRate: real("judge_agreement_rate"),
  nonInferiorityPass: boolean("non_inferiority_pass").notNull().default(false),
  recommendation: text("recommendation").notNull(), // pass | hold | rollback
  recommendationReasons: jsonb("recommendation_reasons").$type<string[]>().default([]),
  // Per-reading-type/per-tag breakdown ({ [tag]: { stats, decision } }) so a
  // regression confined to one reading type inside a pooled track (e.g. tarot
  // inside brief_readings) is visible instead of hidden in the blended
  // aggregate above (judge-llm-evaluation-framework.md §6.3).
  perTagResults: jsonb("per_tag_results"),
  costComparison: jsonb("cost_comparison"),
  latencyComparison: jsonb("latency_comparison"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalConfigVersions = pgTable("eval_config_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  configKey: text("config_key").notNull(), // e.g. "global", "my_day_model_comparison"
  version: integer("version").notNull(),
  value: jsonb("value").notNull(), // JudgeConfig shape, see shared/config-schema.ts
  isActive: boolean("is_active").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyVersionUnique: unique().on(t.configKey, t.version),
}));

export const evalAuditLog = pgTable("eval_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventName: text("event_name").notNull(),
  actor: text("actor").notNull(),
  experimentId: uuid("experiment_id"),
  jobId: uuid("job_id"),
  datasetId: uuid("dataset_id"),
  configVersionId: uuid("config_version_id"),
  promptVersion: text("prompt_version"),
  model: text("model"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalIdempotencyKeys = pgTable("eval_idempotency_keys", {
  key: text("key").primaryKey(),
  jobId: uuid("job_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
