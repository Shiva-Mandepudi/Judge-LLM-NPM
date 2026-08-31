import "dotenv/config";
import { pool } from "../server/db.js";
const result = await pool.query(`
  WITH all_readings AS (
    SELECT rg.model, 'Standard' AS tier, rg.tokens_prompt, rg.tokens_completion, rg.tokens_total, rg.tokens_cached, rg.latency_ms, rg.cost_usd
      FROM eval_reference_generations rg JOIN eval_dataset_cases c ON c.id=rg.case_id
     WHERE c.case_key LIKE 'cb-actor-001:%' AND rg.error IS NULL
    UNION ALL
    SELECT g.model, 'Batch API' AS tier, g.tokens_prompt, g.tokens_completion, g.tokens_total, g.tokens_cached, g.latency_ms, g.cost_usd
      FROM eval_generations g JOIN eval_jobs j ON j.id=g.job_id JOIN eval_dataset_cases c ON c.id=j.case_id
     WHERE c.case_key LIKE 'cb-actor-001:%' AND g.execution_mode='openai_batch' AND g.error IS NULL
  )
  SELECT tier, model, COUNT(*)::int AS readings, SUM(tokens_prompt)::int AS prompt_tokens,
         SUM(tokens_completion)::int AS completion_tokens, SUM(tokens_total)::int AS total_tokens,
         SUM(COALESCE(tokens_cached,0))::int AS cached_tokens, SUM(cost_usd)::double precision AS cost_usd,
         AVG(latency_ms)::double precision AS avg_latency_ms
    FROM all_readings GROUP BY tier,model ORDER BY tier`);
console.log(JSON.stringify(result.rows, null, 2));
await pool.end();
