-- Benchmark storage only. This migration creates the reusable dataset,
-- frozen-reference, and standard/Batch execution schema without inserting
-- dataset cases, user snapshots, model outputs, or experiment rows.

CREATE TABLE IF NOT EXISTS eval_dataset_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  subject_key text NOT NULL,
  source_reference_hash text,
  subject_snapshot jsonb NOT NULL,
  subject_checksum text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, subject_key)
);
CREATE INDEX IF NOT EXISTS eval_dataset_subjects_dataset_idx
  ON eval_dataset_subjects (dataset_id);

ALTER TABLE eval_dataset_cases
  ADD COLUMN IF NOT EXISTS subject_id uuid,
  ADD COLUMN IF NOT EXISTS reading_type text,
  ADD COLUMN IF NOT EXISTS reading_subtype text,
  ADD COLUMN IF NOT EXISTS input_checksum text,
  ADD COLUMN IF NOT EXISTS schema_version text,
  ADD COLUMN IF NOT EXISTS calculator_version text,
  ADD COLUMN IF NOT EXISTS provenance jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eval_dataset_cases_subject_id_fkey'
  ) THEN
    ALTER TABLE eval_dataset_cases
      ADD CONSTRAINT eval_dataset_cases_subject_id_fkey
      FOREIGN KEY (subject_id) REFERENCES eval_dataset_subjects(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS eval_dataset_cases_dataset_subject_idx
  ON eval_dataset_cases (dataset_id, subject_id);

CREATE TABLE IF NOT EXISTS eval_reference_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  name text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('cg_standard', 'openai_batch')),
  endpoint text,
  prompt_version text,
  schema_version text,
  calculator_version text,
  dataset_checksum text NOT NULL,
  generation_config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'generating', 'validating', 'frozen', 'failed')),
  case_count integer NOT NULL DEFAULT 0 CHECK (case_count >= 0),
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  frozen_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_reference_runs_dataset_idx
  ON eval_reference_runs (dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eval_reference_runs_status_idx
  ON eval_reference_runs (status, created_at DESC);

ALTER TABLE eval_experiments
  ADD COLUMN IF NOT EXISTS reference_run_id uuid,
  ADD COLUMN IF NOT EXISTS comparison_type text NOT NULL DEFAULT 'model',
  ADD COLUMN IF NOT EXISTS baseline_execution_mode text NOT NULL DEFAULT 'cg_standard',
  ADD COLUMN IF NOT EXISTS candidate_execution_mode text NOT NULL DEFAULT 'cg_standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eval_experiments_reference_run_id_fkey'
  ) THEN
    ALTER TABLE eval_experiments
      ADD CONSTRAINT eval_experiments_reference_run_id_fkey
      FOREIGN KEY (reference_run_id) REFERENCES eval_reference_runs(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eval_experiments_comparison_type_check'
  ) THEN
    ALTER TABLE eval_experiments
      ADD CONSTRAINT eval_experiments_comparison_type_check
      CHECK (comparison_type IN ('model', 'execution_mode'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eval_experiments_execution_modes_check'
  ) THEN
    ALTER TABLE eval_experiments
      ADD CONSTRAINT eval_experiments_execution_modes_check
      CHECK (
        baseline_execution_mode IN ('cg_standard', 'openai_batch')
        AND candidate_execution_mode IN ('cg_standard', 'openai_batch')
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS eval_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid REFERENCES eval_experiments(id),
  reference_run_id uuid REFERENCES eval_reference_runs(id),
  arm text CHECK (arm IS NULL OR arm IN ('baseline', 'candidate')),
  execution_mode text NOT NULL CHECK (execution_mode IN ('cg_standard', 'openai_batch')),
  provider text NOT NULL,
  model text NOT NULL,
  endpoint text,
  prompt_version text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'in_progress', 'finalizing', 'completed', 'failed', 'cancelled')),
  completion_window text,
  provider_batch_id text,
  input_file_id text,
  output_file_id text,
  error_file_id text,
  total_requests integer NOT NULL DEFAULT 0 CHECK (total_requests >= 0),
  completed_requests integer NOT NULL DEFAULT 0 CHECK (completed_requests >= 0),
  failed_requests integer NOT NULL DEFAULT 0 CHECK (failed_requests >= 0),
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  cached_input_tokens integer,
  reasoning_tokens integer,
  cost_usd real,
  submitted_at timestamptz,
  in_progress_at timestamptz,
  finalizing_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  expires_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((experiment_id IS NOT NULL) <> (reference_run_id IS NOT NULL)),
  UNIQUE (provider, provider_batch_id)
);
CREATE INDEX IF NOT EXISTS eval_generation_runs_experiment_idx
  ON eval_generation_runs (experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eval_generation_runs_reference_idx
  ON eval_generation_runs (reference_run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_reference_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_run_id uuid NOT NULL REFERENCES eval_reference_runs(id),
  case_id uuid NOT NULL REFERENCES eval_dataset_cases(id),
  execution_run_id uuid REFERENCES eval_generation_runs(id),
  provider text NOT NULL,
  model text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('cg_standard', 'openai_batch')),
  prompt_version text NOT NULL,
  request_id text,
  custom_id text,
  provider_request_id text,
  provider_batch_id text,
  raw_output jsonb,
  parsed_output jsonb,
  schema_valid boolean NOT NULL DEFAULT false,
  tokens_prompt integer,
  tokens_completion integer,
  tokens_total integer,
  tokens_cached integer,
  tokens_reasoning integer,
  tokens_accepted_prediction integer,
  tokens_rejected_prediction integer,
  system_prompt_tokens integer,
  user_prompt_tokens integer,
  assistant_context_tokens integer,
  latency_ms integer,
  cost_usd real,
  prompt_hash text,
  response_hash text,
  response_character_count integer,
  started_at timestamptz,
  completed_at timestamptz,
  provider_metadata jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_run_id, case_id)
);
CREATE INDEX IF NOT EXISTS eval_reference_generations_run_idx
  ON eval_reference_generations (reference_run_id);
CREATE INDEX IF NOT EXISTS eval_reference_generations_case_idx
  ON eval_reference_generations (case_id);

ALTER TABLE eval_generations
  ADD COLUMN IF NOT EXISTS execution_run_id uuid,
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'cg_standard',
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS custom_id text,
  ADD COLUMN IF NOT EXISTS provider_request_id text,
  ADD COLUMN IF NOT EXISTS provider_batch_id text,
  ADD COLUMN IF NOT EXISTS endpoint text,
  ADD COLUMN IF NOT EXISTS tokens_total integer,
  ADD COLUMN IF NOT EXISTS tokens_cached integer,
  ADD COLUMN IF NOT EXISTS tokens_reasoning integer,
  ADD COLUMN IF NOT EXISTS tokens_accepted_prediction integer,
  ADD COLUMN IF NOT EXISTS tokens_rejected_prediction integer,
  ADD COLUMN IF NOT EXISTS system_prompt_tokens integer,
  ADD COLUMN IF NOT EXISTS user_prompt_tokens integer,
  ADD COLUMN IF NOT EXISTS assistant_context_tokens integer,
  ADD COLUMN IF NOT EXISTS prompt_hash text,
  ADD COLUMN IF NOT EXISTS response_hash text,
  ADD COLUMN IF NOT EXISTS response_character_count integer,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eval_generations_execution_run_id_fkey'
  ) THEN
    ALTER TABLE eval_generations
      ADD CONSTRAINT eval_generations_execution_run_id_fkey
      FOREIGN KEY (execution_run_id) REFERENCES eval_generation_runs(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eval_generations_execution_mode_check'
  ) THEN
    ALTER TABLE eval_generations
      ADD CONSTRAINT eval_generations_execution_mode_check
      CHECK (execution_mode IN ('cg_standard', 'openai_batch'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS eval_generations_execution_run_idx
  ON eval_generations (execution_run_id);
CREATE INDEX IF NOT EXISTS eval_generations_custom_id_idx
  ON eval_generations (custom_id);

ALTER TABLE eval_judge_scores
  ADD COLUMN IF NOT EXISTS provider_request_id text,
  ADD COLUMN IF NOT EXISTS tokens_prompt integer,
  ADD COLUMN IF NOT EXISTS tokens_completion integer,
  ADD COLUMN IF NOT EXISTS tokens_total integer,
  ADD COLUMN IF NOT EXISTS tokens_cached integer,
  ADD COLUMN IF NOT EXISTS tokens_reasoning integer,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb;
