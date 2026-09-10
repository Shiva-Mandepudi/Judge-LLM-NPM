-- Complete LLM request telemetry. Every provider attempt is recorded,
-- including failed and retried calls, before result rows are evaluated.

CREATE TABLE IF NOT EXISTS eval_llm_request_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES eval_jobs(id),
  run_id uuid REFERENCES eval_comparison_runs(id),
  request_kind text NOT NULL,
  judge_role text,
  request_id text NOT NULL,
  attempt integer NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  endpoint text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  latency_ms integer,
  provider_request_id text,
  tokens_prompt integer,
  tokens_completion integer,
  tokens_total integer,
  tokens_cached integer,
  tokens_cache_write integer,
  tokens_reasoning integer,
  tokens_accepted_prediction integer,
  tokens_rejected_prediction integer,
  system_prompt_tokens integer,
  user_prompt_tokens integer,
  assistant_context_tokens integer,
  prompt_character_count integer,
  token_breakdown_source text,
  cost_usd real,
  cost_status text,
  cost_source text,
  provider_metadata jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_llm_request_attempts_job_idx
  ON eval_llm_request_attempts (job_id, created_at);
CREATE INDEX IF NOT EXISTS eval_llm_request_attempts_request_idx
  ON eval_llm_request_attempts (request_id, attempt);

ALTER TABLE eval_generations ADD COLUMN IF NOT EXISTS tokens_cache_write integer;
ALTER TABLE eval_generations ADD COLUMN IF NOT EXISTS prompt_character_count integer;
ALTER TABLE eval_generations ADD COLUMN IF NOT EXISTS token_breakdown_source text;

ALTER TABLE eval_reference_generations ADD COLUMN IF NOT EXISTS tokens_cache_write integer;
ALTER TABLE eval_reference_generations ADD COLUMN IF NOT EXISTS prompt_character_count integer;
ALTER TABLE eval_reference_generations ADD COLUMN IF NOT EXISTS token_breakdown_source text;

ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS tokens_cache_write integer;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS system_prompt_tokens integer;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS user_prompt_tokens integer;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS assistant_context_tokens integer;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS prompt_character_count integer;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS token_breakdown_source text;
