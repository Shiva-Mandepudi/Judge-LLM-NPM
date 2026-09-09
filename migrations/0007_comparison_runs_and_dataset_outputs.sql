-- Separate reusable comparison configuration from each user/readings execution.
-- Dataset cases and subjects are immutable and intentionally untouched.

CREATE TABLE IF NOT EXISTS eval_dataset_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  case_id uuid NOT NULL REFERENCES eval_dataset_cases(id),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  raw_output jsonb,
  parsed_output jsonb,
  schema_valid boolean NOT NULL DEFAULT false,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, case_id)
);
CREATE INDEX IF NOT EXISTS eval_dataset_outputs_dataset_idx ON eval_dataset_outputs (dataset_id);

CREATE TABLE IF NOT EXISTS eval_comparison_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL REFERENCES eval_experiments(id),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  user_keys jsonb NOT NULL DEFAULT '[]',
  requested_cases integer NOT NULL DEFAULT 0,
  completed_cases integer NOT NULL DEFAULT 0,
  failed_cases integer NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT eval_comparison_runs_comparison_fk FOREIGN KEY (comparison_id) REFERENCES eval_experiments(id)
);
CREATE INDEX IF NOT EXISTS eval_comparison_runs_comparison_idx ON eval_comparison_runs (comparison_id, created_at);
CREATE INDEX IF NOT EXISTS eval_comparison_runs_dataset_idx ON eval_comparison_runs (dataset_id);

ALTER TABLE eval_jobs ADD COLUMN IF NOT EXISTS run_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'eval_jobs_run_id_fkey'
  ) THEN
    ALTER TABLE eval_jobs ADD CONSTRAINT eval_jobs_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES eval_comparison_runs(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS eval_jobs_run_idx ON eval_jobs (run_id);
