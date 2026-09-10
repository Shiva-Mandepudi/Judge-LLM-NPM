-- Persist brief/detailed/full selection for each comparison run.
-- An empty array means all available reading depths.
ALTER TABLE eval_comparison_runs
  ADD COLUMN IF NOT EXISTS reading_subtypes jsonb NOT NULL DEFAULT '[]';
