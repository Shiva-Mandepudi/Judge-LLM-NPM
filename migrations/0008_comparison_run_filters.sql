-- Persist the user-facing reading-type filter selected for each run.
-- An empty array means all available reading types for backwards compatibility.
ALTER TABLE eval_comparison_runs
  ADD COLUMN IF NOT EXISTS reading_types jsonb NOT NULL DEFAULT '[]';
