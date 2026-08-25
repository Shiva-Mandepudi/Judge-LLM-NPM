-- Ground-truth comparisons use an immutable dataset/reference output as the
-- baseline and call Cosmic Guidance only for the selected comparison model.
ALTER TABLE eval_dataset_cases
  ADD COLUMN IF NOT EXISTS gold_output jsonb;

ALTER TABLE eval_experiments
  DROP CONSTRAINT IF EXISTS eval_experiments_comparison_type_check;

ALTER TABLE eval_experiments
  ADD CONSTRAINT eval_experiments_comparison_type_check
  CHECK (comparison_type IN ('model', 'execution_mode', 'ground_truth'));

-- The old aggregate cost/latency comparison was not a reliable evaluation
-- signal. Per-request provider metadata remains available for diagnostics,
-- but these misleading summary fields are removed.
ALTER TABLE eval_results_summaries
  DROP COLUMN IF EXISTS cost_comparison,
  DROP COLUMN IF EXISTS latency_comparison;
