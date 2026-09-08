-- Phase 0 rebuild artifacts. The legacy evaluator tables remain read-only;
-- these tables are the new pipeline's isolated storage boundary.

CREATE TABLE IF NOT EXISTS eval_silver_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track text NOT NULL,
  stratum_key text NOT NULL,
  output jsonb NOT NULL,
  review_status text NOT NULL,
  prompt_version text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (track, stratum_key, prompt_version)
);

CREATE TABLE IF NOT EXISTS eval_rows (
  row_id text PRIMARY KEY,
  run_id text NOT NULL,
  user_id text NOT NULL,
  track text NOT NULL,
  stratum jsonb NOT NULL,
  model_ref text NOT NULL,
  input_snapshot jsonb NOT NULL,
  candidate_output jsonb,
  silver_output jsonb,
  generation jsonb NOT NULL,
  load_status text NOT NULL CHECK (load_status IN ('ok', 'unparseable', 'missing_candidate', 'missing_silver')),
  provenance jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_rows_run_idx ON eval_rows (run_id);
CREATE INDEX IF NOT EXISTS eval_rows_user_idx ON eval_rows (run_id, user_id);

CREATE TABLE IF NOT EXISTS eval_model_map (
  run_id text NOT NULL,
  model_ref text NOT NULL,
  model text NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  PRIMARY KEY (run_id, model_ref)
);

-- Reconcile a table created by an earlier schema-sync attempt that used a UNIQUE
-- constraint for this key. No data is removed; the existing uniqueness is retained
-- as the intended primary key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'eval_model_map'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE eval_model_map DROP CONSTRAINT IF EXISTS eval_model_map_run_id_model_ref_unique;
    ALTER TABLE eval_model_map ADD CONSTRAINT eval_model_map_pkey PRIMARY KEY (run_id, model_ref);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS eval_judgements_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id text NOT NULL REFERENCES eval_rows(row_id),
  run_id text NOT NULL,
  track text NOT NULL,
  user_id text NOT NULL,
  model_ref text NOT NULL,
  judge_model text NOT NULL,
  judge_effort text NOT NULL,
  kernel_hash text NOT NULL,
  rubric_pack_hash text NOT NULL,
  schema_hash text NOT NULL,
  usage jsonb NOT NULL,
  latency_ms integer NOT NULL,
  cost_usd real,
  judge_status text NOT NULL CHECK (judge_status IN ('ok', 'invalid', 'error')),
  attempt integer NOT NULL CHECK (attempt > 0),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (row_id, attempt)
);
CREATE INDEX IF NOT EXISTS eval_judgements_v2_run_idx ON eval_judgements_v2 (run_id);

CREATE TABLE IF NOT EXISTS eval_run_manifests (
  run_id text PRIMARY KEY,
  config_snapshot jsonb NOT NULL,
  prompt_hashes jsonb NOT NULL,
  git_sha text,
  bootstrap_seed text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
