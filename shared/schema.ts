import { pgTable, text, uuid, integer, boolean, jsonb, timestamp, real, unique, index, primaryKey } from "drizzle-orm/pg-core";

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

export const evalExecutionModes = ["cg_standard", "openai_batch"] as const;
export type EvalExecutionMode = (typeof evalExecutionModes)[number];

export const evalGenerationRunStatuses = ["pending", "submitted", "in_progress", "finalizing", "completed", "failed", "cancelled"] as const;
export type EvalGenerationRunStatus = (typeof evalGenerationRunStatuses)[number];

export const evalReferenceRunStatuses = ["draft", "generating", "validating", "frozen", "failed"] as const;
export type EvalReferenceRunStatus = (typeof evalReferenceRunStatuses)[number];

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

// One de-identified test subject can own several cases across reading types.
// This stores benchmark inputs only; it never stores a Cosmic Guidance user
// ID, name, email, or other direct identity value.
export const evalDatasetSubjects = pgTable("eval_dataset_subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  subjectKey: text("subject_key").notNull(),
  sourceReferenceHash: text("source_reference_hash"),
  subjectSnapshot: jsonb("subject_snapshot").notNull(),
  subjectChecksum: text("subject_checksum").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  datasetSubjectUnique: unique().on(t.datasetId, t.subjectKey),
  datasetIdx: index("eval_dataset_subjects_dataset_idx").on(t.datasetId),
}));

export const evalDatasetCases = pgTable("eval_dataset_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  subjectId: uuid("subject_id").references(() => evalDatasetSubjects.id, { onDelete: "set null" }),
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
  readingType: text("reading_type"),
  readingSubtype: text("reading_subtype"),
  inputChecksum: text("input_checksum"),
  schemaVersion: text("schema_version"),
  calculatorVersion: text("calculator_version"),
  provenance: jsonb("provenance"),
  // Immutable reference reading supplied by the dataset owner. When present,
  // ground-truth comparisons use this output instead of regenerating the
  // baseline through Cosmic Guidance.
  goldOutput: jsonb("gold_output"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  datasetCaseUnique: unique().on(t.datasetId, t.caseKey),
  datasetSubjectIdx: index("eval_dataset_cases_dataset_subject_idx").on(t.datasetId, t.subjectId),
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
  referenceRunId: uuid("reference_run_id").references(() => evalReferenceRuns.id),
  comparisonType: text("comparison_type").notNull().default("model"),
  baselineExecutionMode: text("baseline_execution_mode").notNull().default("cg_standard"),
  candidateExecutionMode: text("candidate_execution_mode").notNull().default("cg_standard"),
  secondaryJudgeSampleRate: real("secondary_judge_sample_rate").notNull().default(0.2),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A comparison is reusable configuration; a run is one execution of it over
// selected dataset subjects. Keeping these separate prevents one comparison
// with 100 users from becoming an unreadable list of unrelated jobs.
export const comparisonRunStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type ComparisonRunStatus = (typeof comparisonRunStatuses)[number];

export const evalComparisonRuns = pgTable("eval_comparison_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  comparisonId: uuid("comparison_id").notNull().references(() => evalExperiments.id),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  status: text("status").notNull().default("queued"),
  userKeys: jsonb("user_keys").$type<string[]>().notNull().default([]),
  readingTypes: jsonb("reading_types").$type<string[]>().notNull().default([]),
  requestedCases: integer("requested_cases").notNull().default(0),
  completedCases: integer("completed_cases").notNull().default(0),
  failedCases: integer("failed_cases").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  comparisonIdx: index("eval_comparison_runs_comparison_idx").on(t.comparisonId, t.createdAt),
  datasetIdx: index("eval_comparison_runs_dataset_idx").on(t.datasetId),
}));

// Current generated readings belong to the immutable dataset, not to a user
// comparison run. This preserves the 100-user corpus when old runs are cleaned.
export const evalDatasetOutputs = pgTable("eval_dataset_outputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  caseId: uuid("case_id").notNull().references(() => evalDatasetCases.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  rawOutput: jsonb("raw_output"),
  parsedOutput: jsonb("parsed_output"),
  schemaValid: boolean("schema_valid").notNull().default(false),
  usage: jsonb("usage"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  datasetCaseUnique: unique().on(t.datasetId, t.caseId),
  datasetIdx: index("eval_dataset_outputs_dataset_idx").on(t.datasetId),
}));

export const jobStatuses = ["pending", "generating", "checking", "judging", "completed", "failed"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const evalJobs = pgTable("eval_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentId: uuid("experiment_id").notNull().references(() => evalExperiments.id),
  runId: uuid("run_id").references(() => evalComparisonRuns.id),
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

// One lifecycle per experiment arm or reference run. Batch-level provider
// state belongs here; individual case outputs belong in generation tables.
export const evalGenerationRuns = pgTable("eval_generation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentId: uuid("experiment_id").references(() => evalExperiments.id),
  referenceRunId: uuid("reference_run_id").references(() => evalReferenceRuns.id),
  arm: text("arm"),
  executionMode: text("execution_mode").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  endpoint: text("endpoint"),
  promptVersion: text("prompt_version"),
  status: text("status").notNull().default("pending"),
  completionWindow: text("completion_window"),
  providerBatchId: text("provider_batch_id"),
  inputFileId: text("input_file_id"),
  outputFileId: text("output_file_id"),
  errorFileId: text("error_file_id"),
  totalRequests: integer("total_requests").notNull().default(0),
  completedRequests: integer("completed_requests").notNull().default(0),
  failedRequests: integer("failed_requests").notNull().default(0),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  costUsd: real("cost_usd"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  inProgressAt: timestamp("in_progress_at", { withTimezone: true }),
  finalizingAt: timestamp("finalizing_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  experimentIdx: index("eval_generation_runs_experiment_idx").on(t.experimentId),
  referenceIdx: index("eval_generation_runs_reference_idx").on(t.referenceRunId),
  providerBatchUnique: unique().on(t.provider, t.providerBatchId),
}));

export const evalPreparedRequests = pgTable("eval_prepared_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  executionRunId: uuid("execution_run_id").notNull().references(() => evalGenerationRuns.id),
  caseId: uuid("case_id").notNull().references(() => evalDatasetCases.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  endpoint: text("endpoint").notNull(),
  promptVersion: text("prompt_version").notNull(),
  customId: text("custom_id").notNull(),
  requestBody: jsonb("request_body").notNull(),
  requestBodyChecksum: text("request_body_checksum").notNull(),
  systemPromptTokens: integer("system_prompt_tokens").notNull(),
  userPromptTokens: integer("user_prompt_tokens").notNull(),
  assistantContextTokens: integer("assistant_context_tokens").notNull(),
  promptCharacterCount: integer("prompt_character_count").notNull(),
  systemPromptHash: text("system_prompt_hash"),
  userPromptHash: text("user_prompt_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runCaseUnique: unique().on(t.executionRunId, t.caseId),
  customIdUnique: unique().on(t.customId),
  runIdx: index("eval_prepared_requests_run_idx").on(t.executionRunId, t.createdAt),
}));

// One immutable reference output per dataset case. Candidate experiments
// reuse these rows instead of regenerating the baseline.
export const evalReferenceGenerations = pgTable("eval_reference_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  referenceRunId: uuid("reference_run_id").notNull().references(() => evalReferenceRuns.id),
  caseId: uuid("case_id").notNull().references(() => evalDatasetCases.id),
  executionRunId: uuid("execution_run_id").references(() => evalGenerationRuns.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  executionMode: text("execution_mode").notNull(),
  promptVersion: text("prompt_version").notNull(),
  requestId: text("request_id"),
  customId: text("custom_id"),
  providerRequestId: text("provider_request_id"),
  providerBatchId: text("provider_batch_id"),
  rawOutput: jsonb("raw_output"),
  parsedOutput: jsonb("parsed_output"),
  schemaValid: boolean("schema_valid").notNull().default(false),
  tokensPrompt: integer("tokens_prompt"),
  tokensCompletion: integer("tokens_completion"),
  tokensTotal: integer("tokens_total"),
  tokensCached: integer("tokens_cached"),
  tokensReasoning: integer("tokens_reasoning"),
  tokensAcceptedPrediction: integer("tokens_accepted_prediction"),
  tokensRejectedPrediction: integer("tokens_rejected_prediction"),
  systemPromptTokens: integer("system_prompt_tokens"),
  userPromptTokens: integer("user_prompt_tokens"),
  assistantContextTokens: integer("assistant_context_tokens"),
  latencyMs: integer("latency_ms"),
  costUsd: real("cost_usd"),
  promptHash: text("prompt_hash"),
  responseHash: text("response_hash"),
  responseCharacterCount: integer("response_character_count"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  providerMetadata: jsonb("provider_metadata"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  referenceCaseUnique: unique().on(t.referenceRunId, t.caseId),
  referenceRunIdx: index("eval_reference_generations_run_idx").on(t.referenceRunId),
  caseIdx: index("eval_reference_generations_case_idx").on(t.caseId),
}));

export const evalGenerations = pgTable("eval_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  executionRunId: uuid("execution_run_id").references(() => evalGenerationRuns.id),
  arm: text("arm").notNull(), // baseline | candidate
  executionMode: text("execution_mode").notNull().default("cg_standard"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  requestId: text("request_id"),
  customId: text("custom_id"),
  providerRequestId: text("provider_request_id"),
  providerBatchId: text("provider_batch_id"),
  endpoint: text("endpoint"),
  rawOutput: jsonb("raw_output"),
  parsedOutput: jsonb("parsed_output"),
  schemaValid: boolean("schema_valid").notNull().default(false),
  tokensPrompt: integer("tokens_prompt"),
  tokensCompletion: integer("tokens_completion"),
  tokensTotal: integer("tokens_total"),
  tokensCached: integer("tokens_cached"),
  tokensReasoning: integer("tokens_reasoning"),
  tokensAcceptedPrediction: integer("tokens_accepted_prediction"),
  tokensRejectedPrediction: integer("tokens_rejected_prediction"),
  systemPromptTokens: integer("system_prompt_tokens"),
  userPromptTokens: integer("user_prompt_tokens"),
  assistantContextTokens: integer("assistant_context_tokens"),
  latencyMs: integer("latency_ms"),
  costUsd: real("cost_usd"),
  promptHash: text("prompt_hash"),
  responseHash: text("response_hash"),
  responseCharacterCount: integer("response_character_count"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  providerMetadata: jsonb("provider_metadata"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  jobIdx: index("eval_generations_job_idx").on(t.jobId),
  executionRunIdx: index("eval_generations_execution_run_idx").on(t.executionRunId),
  customIdIdx: index("eval_generations_custom_id_idx").on(t.customId),
}));

export const evalDeterministicResults = pgTable("eval_deterministic_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  arm: text("arm").notNull(),
  checkName: text("check_name").notNull(),
  passed: boolean("passed").notNull(),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalDeterministicArtifacts = pgTable("eval_deterministic_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => evalDatasetCases.id),
  artifactType: text("artifact_type").notNull(),
  outputSnapshot: jsonb("output_snapshot").notNull(),
  outputChecksum: text("output_checksum").notNull(),
  provenance: jsonb("provenance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseArtifactUnique: unique().on(t.caseId, t.artifactType),
  caseIdx: index("eval_deterministic_artifacts_case_idx").on(t.caseId),
}));

export const evalJudgeScores = pgTable("eval_judge_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => evalJobs.id),
  judgeRole: text("judge_role").notNull(), // primary | secondary
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  dimensionScores: jsonb("dimension_scores").notNull(), // legacy numeric aspect scores; new rows store {}
  hardGateResults: jsonb("hard_gate_results").notNull(), // { dimension: { pass, violationDetail } }
  pairwiseWinner: text("pairwise_winner"), // A | B | Tie | null for single-arm
  rationale: text("rationale"),
  confidenceLevel: text("confidence_level"),
  rawResponse: jsonb("raw_response"),
  providerRequestId: text("provider_request_id"),
  tokensPrompt: integer("tokens_prompt"),
  tokensCompletion: integer("tokens_completion"),
  tokensTotal: integer("tokens_total"),
  tokensCached: integer("tokens_cached"),
  tokensReasoning: integer("tokens_reasoning"),
  providerMetadata: jsonb("provider_metadata"),
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

// Frozen high-quality outputs reused by later experiments. Keeping these
// outside eval_generations prevents the baseline from being regenerated or
// duplicated for every candidate model.
export const evalReferenceRuns = pgTable("eval_reference_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  datasetId: uuid("dataset_id").notNull().references(() => evalDatasets.id),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  executionMode: text("execution_mode").notNull(),
  endpoint: text("endpoint"),
  promptVersion: text("prompt_version"),
  schemaVersion: text("schema_version"),
  calculatorVersion: text("calculator_version"),
  datasetChecksum: text("dataset_checksum").notNull(),
  generationConfig: jsonb("generation_config").notNull(),
  status: text("status").notNull().default("draft"),
  caseCount: integer("case_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// Rebuild artifacts. These tables are intentionally separate from the legacy
// pairwise evaluator above; old rows remain historical and are never dual-written.
export const evalSilverOutputs = pgTable("eval_silver_outputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  track: text("track").notNull(),
  stratumKey: text("stratum_key").notNull(),
  output: jsonb("output").notNull(),
  reviewStatus: text("review_status").notNull(),
  promptVersion: text("prompt_version").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  trackStratumVersionUnique: unique().on(t.track, t.stratumKey, t.promptVersion),
}));

export const evalRows = pgTable("eval_rows", {
  rowId: text("row_id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  track: text("track").notNull(),
  stratum: jsonb("stratum").notNull(),
  modelRef: text("model_ref").notNull(),
  inputSnapshot: jsonb("input_snapshot").notNull(),
  candidateOutput: jsonb("candidate_output"),
  silverOutput: jsonb("silver_output"),
  generation: jsonb("generation").notNull(),
  loadStatus: text("load_status").notNull(),
  provenance: jsonb("provenance"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index("eval_rows_run_idx").on(t.runId),
  userIdx: index("eval_rows_user_idx").on(t.runId, t.userId),
}));

export const evalModelMap = pgTable("eval_model_map", {
  runId: text("run_id").notNull(),
  modelRef: text("model_ref").notNull(),
  model: text("model").notNull(),
  sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull().defaultNow(),
  contentHash: text("content_hash").notNull(),
}, (t) => ({
  runModelRefPk: primaryKey({ columns: [t.runId, t.modelRef] }),
}));

export const evalJudgementsV2 = pgTable("eval_judgements_v2", {
  id: uuid("id").primaryKey().defaultRandom(),
  rowId: text("row_id").notNull().references(() => evalRows.rowId),
  runId: text("run_id").notNull(),
  track: text("track").notNull(),
  userId: text("user_id").notNull(),
  modelRef: text("model_ref").notNull(),
  judgeModel: text("judge_model").notNull(),
  judgeEffort: text("judge_effort").notNull(),
  kernelHash: text("kernel_hash").notNull(),
  rubricPackHash: text("rubric_pack_hash").notNull(),
  schemaHash: text("schema_hash").notNull(),
  usage: jsonb("usage").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  costUsd: real("cost_usd"),
  judgeStatus: text("judge_status").notNull(),
  attempt: integer("attempt").notNull(),
  response: jsonb("response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rowAttemptUnique: unique().on(t.rowId, t.attempt),
  runIdx: index("eval_judgements_v2_run_idx").on(t.runId),
}));

export const evalRunManifests = pgTable("eval_run_manifests", {
  runId: text("run_id").primaryKey(),
  configSnapshot: jsonb("config_snapshot").notNull(),
  promptHashes: jsonb("prompt_hashes").notNull(),
  gitSha: text("git_sha"),
  bootstrapSeed: text("bootstrap_seed").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
