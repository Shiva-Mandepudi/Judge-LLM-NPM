-- Judge-LLM service schema. Lives in its own database (JUDGE_DATABASE_URL),
-- never the Cosmic Guidance product database. No foreign keys into product
-- tables (users/profiles/subscriptions/credits/conversations/readings) exist
-- anywhere in this schema by design.

CREATE TABLE IF NOT EXISTS eval_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track text NOT NULL,
  version text NOT NULL,
  description text,
  source_checksum text NOT NULL,
  case_count integer NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (track, version)
);

CREATE TABLE IF NOT EXISTS eval_dataset_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  case_key text NOT NULL,
  track text NOT NULL,
  input_snapshot jsonb NOT NULL,
  prompt_version text NOT NULL,
  tags jsonb DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, case_key)
);

CREATE TABLE IF NOT EXISTS eval_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key text NOT NULL,
  version integer NOT NULL,
  value jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (config_key, version)
);
CREATE INDEX IF NOT EXISTS idx_eval_config_versions_active ON eval_config_versions (config_key) WHERE is_active;

CREATE TABLE IF NOT EXISTS eval_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  track text NOT NULL,
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  baseline_model text NOT NULL,
  candidate_model text NOT NULL,
  baseline_prompt_version text NOT NULL,
  candidate_prompt_version text NOT NULL,
  config_version_id uuid NOT NULL REFERENCES eval_config_versions(id),
  secondary_judge_sample_rate real NOT NULL DEFAULT 0.2,
  status text NOT NULL DEFAULT 'draft',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES eval_experiments(id),
  case_id uuid NOT NULL REFERENCES eval_dataset_cases(id),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  blind_label_map jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_eval_jobs_experiment ON eval_jobs (experiment_id);
CREATE INDEX IF NOT EXISTS idx_eval_jobs_status ON eval_jobs (status);

CREATE TABLE IF NOT EXISTS eval_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES eval_jobs(id),
  arm text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  raw_output jsonb,
  parsed_output jsonb,
  schema_valid boolean NOT NULL DEFAULT false,
  tokens_prompt integer,
  tokens_completion integer,
  latency_ms integer,
  cost_usd real,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_generations_job ON eval_generations (job_id);

CREATE TABLE IF NOT EXISTS eval_deterministic_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES eval_jobs(id),
  arm text NOT NULL,
  check_name text NOT NULL,
  passed boolean NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_det_results_job ON eval_deterministic_results (job_id);

CREATE TABLE IF NOT EXISTS eval_judge_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES eval_jobs(id),
  judge_role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  rubric_version text NOT NULL,
  dimension_scores jsonb NOT NULL,
  hard_gate_results jsonb NOT NULL,
  pairwise_winner text,
  rationale text,
  confidence_level text,
  raw_response jsonb,
  latency_ms integer,
  cost_usd real,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_judge_scores_job ON eval_judge_scores (job_id);

CREATE TABLE IF NOT EXISTS eval_human_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES eval_jobs(id),
  experiment_id uuid NOT NULL REFERENCES eval_experiments(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  assigned_to text,
  resolution_notes text,
  resolution_decision text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_human_review_status ON eval_human_review_queue (status);

CREATE TABLE IF NOT EXISTS eval_results_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES eval_experiments(id),
  sample_size integer NOT NULL,
  mean_dimension_scores jsonb NOT NULL,
  dimension_deltas jsonb NOT NULL,
  win_rate real,
  tie_rate real,
  loss_rate real,
  hard_gate_failure_count integer NOT NULL DEFAULT 0,
  judge_agreement_rate real,
  non_inferiority_pass boolean NOT NULL DEFAULT false,
  recommendation text NOT NULL,
  recommendation_reasons jsonb DEFAULT '[]',
  cost_comparison jsonb,
  latency_comparison jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_results_experiment ON eval_results_summaries (experiment_id);

CREATE TABLE IF NOT EXISTS eval_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name text NOT NULL,
  actor text NOT NULL,
  experiment_id uuid,
  job_id uuid,
  dataset_id uuid,
  config_version_id uuid,
  prompt_version text,
  model text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_audit_log_experiment ON eval_audit_log (experiment_id);
CREATE INDEX IF NOT EXISTS idx_eval_audit_log_created_at ON eval_audit_log (created_at);

CREATE TABLE IF NOT EXISTS eval_idempotency_keys (
  key text PRIMARY KEY,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
