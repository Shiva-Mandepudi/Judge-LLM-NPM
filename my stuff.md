Standard generation completed successfully using only `gpt-5.6-sol`, and the exact Batch job is submitted.

- Standard readings stored: `12 / 12`
- Prompt tokens: `766,820`
- Completion tokens: `41,764`
- Total tokens: `808,584`
- Average Standard latency: `68,140 ms`
- Estimated Standard cost: `$3.902560`
- Batch ID: `batch_6a8d80630d808190a30f08dd5c04307f`
- Judge Batch run ID: `087526fc-9541-44dc-8571-d19524e924cb`
- Batch JSONL: `C:\Users\shiva\Desktop\Astroverse\judge-service\artifacts\batches\cb-actor-001-20260824.jsonl`

The Batch JSONL was created from each successful Standard request’s captured OpenAI body, so prompts, model, token cap, and input data match exactly. `gpt-5.6-sol` supports both Chat Completions and Batch. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)

OpenAI Batch is currently submitted/validating. When it completes, run:

```powershell
cd C:\Users\shiva\Desktop\Astroverse\judge-service
npm run batch:import -- --run-id 087526fc-9541-44dc-8571-d19524e924cb
```

Run that command again later if it still reports `submitted` or `in_progress`. Once complete, it imports all Batch outputs, tokens, raw provider lines, request IDs, and run timestamps into `eval_generations`.

Key DB locations:

- Standard outputs and detailed usage: `eval_reference_generations`
- Exact Standard/Batch request body: `provider_metadata.requestBody`
- Batch lifecycle/status: `eval_generation_runs`
- Batch per-reading outputs after import: `eval_generations`

I also corrected GPT-5.6 compatibility: it now uses `max_completion_tokens`, omits unsupported temperature overrides, has an evaluation-only extended timeout, and resume uses the frozen dataset snapshots rather than recalculating them.