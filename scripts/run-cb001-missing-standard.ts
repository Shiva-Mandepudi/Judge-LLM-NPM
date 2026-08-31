import "dotenv/config";
import crypto from "node:crypto";
import { pool } from "../server/db.js";
import { requestGeneration } from "../server/services/generation-client.js";

const DATASET_ID = "30b87fb3-33df-4495-98cf-ee4b4d48abb4";
const EXPERIMENT_ID = "a37e7abf-f4b4-4f4c-b238-f62e5660d5d9";
const MODEL = "gpt-5.6-sol";
const PROMPT_VERSION = "cg-production-current";
const REFERENCE_NAME = "cb-actor-001 missing CG Standard";
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cost = (u: any) => (Number(u.promptTokens) * 4 + Number(u.completionTokens) * 20) / 1_000_000;
const text = (value: unknown) => typeof value === "string" ? value : null;

const cases = (await pool.query(
  `SELECT id,case_key,track,reading_type,reading_subtype,input_snapshot
     FROM eval_dataset_cases
    WHERE dataset_id=$1 AND case_key LIKE 'cb-actor-001:%'
      AND track IN ('numerology','zodiac_profile','universal_insights')
    ORDER BY case_key`, [DATASET_ID],
)).rows;
if (cases.length !== 14) throw new Error(`Expected 14 missing cases, found ${cases.length}`);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const existingReference = await client.query(
    `SELECT id FROM eval_reference_runs
      WHERE dataset_id=$1 AND name=$2
      ORDER BY created_at DESC LIMIT 1`,
    [DATASET_ID, REFERENCE_NAME],
  );
  let referenceRunId: string;
  let standardRunId: string;
  if (existingReference.rowCount) {
    referenceRunId = existingReference.rows[0].id;
    const existingStandard = await client.query(
      `SELECT id FROM eval_generation_runs
        WHERE reference_run_id=$1 AND execution_mode='cg_standard'
        ORDER BY created_at DESC LIMIT 1`, [referenceRunId],
    );
    if (existingStandard.rowCount) {
      standardRunId = existingStandard.rows[0].id;
    } else {
      const standard = await client.query(
        `INSERT INTO eval_generation_runs (reference_run_id,execution_mode,provider,model,endpoint,prompt_version,status,total_requests)
         VALUES ($1,'cg_standard','cosmic_guidance',$2,'/api/internal/judge/generate',$3,'in_progress',$4) RETURNING id`,
        [referenceRunId, MODEL, PROMPT_VERSION, cases.length],
      );
      standardRunId = standard.rows[0].id;
    }
    await client.query(
      `UPDATE eval_reference_runs SET status='generating',case_count=$1,completed_count=0,failed_count=0,frozen_at=NULL WHERE id=$2`,
      [cases.length, referenceRunId],
    );
    await client.query(
      `UPDATE eval_generation_runs SET status='in_progress',total_requests=$1,failed_requests=0,updated_at=NOW() WHERE id=$2`,
      [cases.length, standardRunId],
    );
  } else {
    const reference = await client.query(
      `INSERT INTO eval_reference_runs (dataset_id,name,provider,model,execution_mode,endpoint,prompt_version,schema_version,calculator_version,dataset_checksum,generation_config,status,case_count,created_by)
       VALUES ($1,$2,$3,$4,'cg_standard','/api/internal/judge/generate',$5,'cg-production-json','cg-astroverse-current',$6,$7::jsonb,'generating',$8,'cg-actor-001-missing-standard') RETURNING id`,
      [DATASET_ID, REFERENCE_NAME, "cosmic_guidance", MODEL, PROMPT_VERSION, hash(cases), JSON.stringify({ model: MODEL, source: "CG production path" }), cases.length],
    );
    referenceRunId = reference.rows[0].id;
    const standard = await client.query(
      `INSERT INTO eval_generation_runs (reference_run_id,execution_mode,provider,model,endpoint,prompt_version,status,total_requests)
       VALUES ($1,'cg_standard','cosmic_guidance',$2,'/api/internal/judge/generate',$3,'in_progress',$4) RETURNING id`,
      [referenceRunId, MODEL, PROMPT_VERSION, cases.length],
    );
    standardRunId = standard.rows[0].id;
  }
  for (const row of cases) {
    await client.query("INSERT INTO eval_jobs (experiment_id,case_id,idempotency_key,status) VALUES ($1,$2,$3,'pending') ON CONFLICT (idempotency_key) DO NOTHING", [EXPERIMENT_ID, row.id, `cb-actor-001-standard-missing:${row.case_key}`]);
  }
  await client.query("COMMIT");

  let completed = 0;
  for (const row of cases) {
    const alreadyStored = await pool.query(
      `SELECT id FROM eval_reference_generations WHERE reference_run_id=$1 AND case_id=$2 LIMIT 1`,
      [referenceRunId, row.id],
    );
    if (alreadyStored.rowCount) {
      completed++;
      console.log(`Standard already stored ${completed}/14: ${row.case_key}`);
      continue;
    }
    const startedAt = new Date();
    const requestId = `cb-actor-001-standard-missing:${row.case_key}`;
    const response = await requestGeneration({ track: row.track, arm: "baseline", model: MODEL, promptVersion: PROMPT_VERSION, inputSnapshot: row.input_snapshot, requestId }, { maxAttempts: 3, baseBackoffMs: 2000, maxBackoffMs: 10000 });
    if (response.model !== MODEL || !response.requestArtifact) throw new Error(`Missing Standard artifact for ${row.case_key}`);
    const artifact = response.requestArtifact as any;
    const job = await pool.query("SELECT id FROM eval_jobs WHERE idempotency_key=$1", [requestId]);
    if (!job.rowCount) throw new Error(`Missing Judge job for ${row.case_key}`);
    const usage = response.usage as any;
    await pool.query(
      `INSERT INTO eval_reference_generations (reference_run_id,case_id,execution_run_id,provider,model,execution_mode,prompt_version,request_id,custom_id,provider_batch_id,provider_request_id,raw_output,parsed_output,schema_valid,tokens_prompt,tokens_completion,tokens_total,tokens_cached,tokens_reasoning,tokens_accepted_prediction,tokens_rejected_prediction,system_prompt_tokens,user_prompt_tokens,assistant_context_tokens,latency_ms,cost_usd,prompt_hash,response_hash,response_character_count,started_at,completed_at,provider_metadata,error)
       VALUES ($1,$2,$3,'cosmic_guidance',$4,'cg_standard',$5,$6,NULL,NULL,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29)`,
      [referenceRunId,row.id,standardRunId,MODEL,PROMPT_VERSION,requestId,text((artifact.providerMetadata as any)?.providerRequestId),JSON.stringify({text:artifact.responseText,responseMetadata:artifact.providerMetadata}),JSON.stringify(response.output),response.schemaValid,usage.promptTokens,usage.completionTokens,usage.totalTokens,usage.cachedPromptTokens??null,usage.reasoningTokens??null,usage.acceptedPredictionTokens??null,usage.rejectedPredictionTokens??null,artifact.systemPromptTokens,artifact.userPromptTokens,artifact.assistantContextTokens,response.latencyMs,cost(usage),artifact.systemPromptHash,hash(artifact.responseText),artifact.responseText.length,startedAt,new Date(),JSON.stringify({requestBody:artifact.requestBody,responseUsage:artifact.usage,providerMetadata:artifact.providerMetadata,promptCharacterCount:artifact.promptCharacterCount,userPromptHash:artifact.userPromptHash}),response.error],
    );
    completed++;
    await pool.query("UPDATE eval_generation_runs SET completed_requests=$1,updated_at=NOW() WHERE id=$2", [completed, standardRunId]);
    await pool.query("UPDATE eval_reference_runs SET completed_count=$1 WHERE id=$2", [completed, referenceRunId]);
    console.log(`Standard stored ${completed}/14: ${row.case_key}`);
  }
  await pool.query("UPDATE eval_generation_runs SET status='completed',completed_requests=$1,failed_requests=0,completed_at=NOW(),updated_at=NOW() WHERE id=$2", [completed, standardRunId]);
  await pool.query("UPDATE eval_reference_runs SET status='frozen',completed_count=$1,frozen_at=NOW() WHERE id=$2", [completed, referenceRunId]);
  console.log(JSON.stringify({ referenceRunId, standardRunId, completed }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally { client.release(); await pool.end(); }
