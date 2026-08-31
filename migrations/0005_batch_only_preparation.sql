-- Batch-only benchmark storage. Prepared requests are persisted before they
-- are uploaded; calculation-only artifacts never create empty AI generations.

ALTER TABLE eval_experiments
  DROP CONSTRAINT IF EXISTS eval_experiments_comparison_type_check;

ALTER TABLE eval_experiments
  ADD CONSTRAINT eval_experiments_comparison_type_check
  CHECK (comparison_type IN ('model', 'execution_mode', 'ground_truth', 'batch_only'));

CREATE TABLE IF NOT EXISTS eval_prepared_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_run_id uuid NOT NULL REFERENCES eval_generation_runs(id),
  case_id uuid NOT NULL REFERENCES eval_dataset_cases(id),
  provider text NOT NULL CHECK (provider = 'openai'),
  model text NOT NULL CHECK (model = 'gpt-5.6-sol'),
  endpoint text NOT NULL CHECK (endpoint = '/v1/chat/completions'),
  prompt_version text NOT NULL,
  custom_id text NOT NULL,
  request_body jsonb NOT NULL,
  request_body_checksum text NOT NULL,
  system_prompt_tokens integer NOT NULL CHECK (system_prompt_tokens >= 0),
  user_prompt_tokens integer NOT NULL CHECK (user_prompt_tokens >= 0),
  assistant_context_tokens integer NOT NULL CHECK (assistant_context_tokens >= 0),
  prompt_character_count integer NOT NULL CHECK (prompt_character_count >= 0),
  system_prompt_hash text,
  user_prompt_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_run_id, case_id),
  UNIQUE (custom_id)
);
CREATE INDEX IF NOT EXISTS eval_prepared_requests_run_idx
  ON eval_prepared_requests (execution_run_id, created_at);

CREATE TABLE IF NOT EXISTS eval_deterministic_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES eval_dataset_cases(id),
  artifact_type text NOT NULL,
  output_snapshot jsonb NOT NULL,
  output_checksum text NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, artifact_type)
);
CREATE INDEX IF NOT EXISTS eval_deterministic_artifacts_case_idx
  ON eval_deterministic_artifacts (case_id);
