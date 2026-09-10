-- Cost Analysis Dashboard, Phase B: immutable pricing snapshots.
-- Official prices are curated in config/pricing-catalog.yaml; each sync writes
-- one snapshot row plus one rate row per catalog entry. Snapshots are
-- append-only — a failed validation inserts a 'failed' snapshot and never
-- mutates the previous 'valid' one.
-- All rate columns stay NULL when a provider does not publish that field;
-- NULL must never be coerced to 0 (0 would read as "free" in cost math).

CREATE TABLE IF NOT EXISTS eval_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL, -- valid | failed
  triggered_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  source_summary jsonb, -- catalog hash, per-provider reachability, counts
  error_summary text
);
CREATE INDEX IF NOT EXISTS eval_pricing_snapshots_status_idx ON eval_pricing_snapshots (status, created_at);

CREATE TABLE IF NOT EXISTS eval_pricing_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES eval_pricing_snapshots(id),
  provider text NOT NULL,
  model_id text NOT NULL,
  usage_mode text NOT NULL DEFAULT 'standard', -- standard | batch | priority | other
  input_usd_per_million real,
  output_usd_per_million real,
  cache_read_usd_per_million real,
  cache_write_usd_per_million real,
  currency text NOT NULL DEFAULT 'USD',
  effective_from text, -- ISO date string, as published by the provider
  effective_to text,
  source_url text,
  source_hash text, -- sha256 of the canonical catalog, same for every row of a snapshot
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, provider, model_id, usage_mode)
);
CREATE INDEX IF NOT EXISTS eval_pricing_rates_model_idx ON eval_pricing_rates (provider, model_id);

-- Link each comparison run to the pricing snapshot its costs were computed
-- against. pricing_status/cost_currency mirror the run-level cost rollup state.
ALTER TABLE eval_comparison_runs ADD COLUMN IF NOT EXISTS pricing_snapshot_id uuid;
ALTER TABLE eval_comparison_runs ADD COLUMN IF NOT EXISTS pricing_status text;
ALTER TABLE eval_comparison_runs ADD COLUMN IF NOT EXISTS cost_currency text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'eval_comparison_runs_pricing_snapshot_fkey'
  ) THEN
    ALTER TABLE eval_comparison_runs ADD CONSTRAINT eval_comparison_runs_pricing_snapshot_fkey
      FOREIGN KEY (pricing_snapshot_id) REFERENCES eval_pricing_snapshots(id);
  END IF;
END $$;

-- Per-generation / per-judge-call cost provenance (declared in shared/schema.ts
-- alongside this phase). attempt supports retry-aware cost attribution.
ALTER TABLE eval_generations ADD COLUMN IF NOT EXISTS cost_status text;
ALTER TABLE eval_generations ADD COLUMN IF NOT EXISTS cost_source text;
ALTER TABLE eval_generations ADD COLUMN IF NOT EXISTS attempt integer;

ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS cost_status text;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS cost_source text;
ALTER TABLE eval_judge_scores ADD COLUMN IF NOT EXISTS attempt integer;

-- Phase C: pre-run cost estimate stored at run start for estimate-vs-actual
-- variance. JSON shape: { cases, estimate: { candidate, primaryJudge,
-- secondaryJudge, total }, tokens, assumptions, pricedWith: { snapshotId } }.
ALTER TABLE eval_comparison_runs ADD COLUMN IF NOT EXISTS cost_estimate jsonb;
