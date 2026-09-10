-- Restore valid current readings that already exist as frozen reference
-- evidence. This only fills missing output snapshots; dataset cases/users are
-- immutable and existing current readings win on conflict.
INSERT INTO eval_dataset_outputs (
  dataset_id, case_id, provider, model, prompt_version,
  raw_output, parsed_output, schema_valid, usage, created_at
)
SELECT DISTINCT ON (c.id)
  c.dataset_id,
  c.id,
  rg.provider,
  rg.model,
  rg.prompt_version,
  rg.raw_output,
  rg.parsed_output,
  rg.schema_valid,
  jsonb_build_object(
    'promptTokens', rg.tokens_prompt,
    'completionTokens', rg.tokens_completion,
    'totalTokens', rg.tokens_total,
    'cachedTokens', rg.tokens_cached,
    'reasoningTokens', rg.tokens_reasoning,
    'latencyMs', rg.latency_ms,
    'costUsd', rg.cost_usd
  ),
  rg.created_at
FROM eval_dataset_cases c
JOIN eval_reference_generations rg ON rg.case_id = c.id
WHERE c.dataset_id = (
  SELECT id FROM eval_datasets
  WHERE track = 'cg_batch_corpus'
    AND version = 'cg-production-batch-only-20260828'
)
  AND c.track <> 'deterministic'
  AND rg.schema_valid = true
  AND rg.parsed_output IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM eval_dataset_outputs existing
    WHERE existing.dataset_id = c.dataset_id AND existing.case_id = c.id
  )
ORDER BY c.id, rg.created_at DESC
ON CONFLICT (dataset_id, case_id) DO NOTHING;
