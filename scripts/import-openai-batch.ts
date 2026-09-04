import "dotenv/config";
import crypto from "node:crypto";
import { pool } from "../server/db.js";

const MODEL = "gpt-5.6-sol";
const BATCH_INPUT_PER_MILLION = 2;
const BATCH_OUTPUT_PER_MILLION = 10;

type JsonRecord = Record<string, any>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function dateFromUnix(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function costUsd(promptTokens: number | null, completionTokens: number | null): number | null {
  if (promptTokens === null || completionTokens === null) return null;
  return (promptTokens * BATCH_INPUT_PER_MILLION + completionTokens * BATCH_OUTPUT_PER_MILLION) / 1_000_000;
}

function parseAssistantContent(responseBody: JsonRecord): { content: string | null; parsed: unknown; parseError: string | null } {
  const content = responseBody.choices?.[0]?.message?.content;
  if (typeof content !== "string") return { content: null, parsed: null, parseError: "Batch response did not contain assistant text" };
  try {
    return { content, parsed: JSON.parse(content), parseError: null };
  } catch (error) {
    return { content, parsed: null, parseError: `Assistant text was not valid JSON: ${String(error)}` };
  }
}

async function openAiJson(endpoint: string): Promise<JsonRecord> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`https://api.openai.com/v1${endpoint}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI ${endpoint} failed (${response.status}): ${text}`);
  return JSON.parse(text) as JsonRecord;
}

async function openAiText(endpoint: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`https://api.openai.com/v1${endpoint}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI ${endpoint} failed (${response.status}): ${text}`);
  return text;
}

function providerStatus(value: unknown): string {
  if (value === "expired") return "failed";
  if (value === "validating") return "submitted";
  if (["in_progress", "finalizing", "completed", "failed", "cancelled"].includes(String(value))) return String(value);
  return "submitted";
}

async function main() {
  const runId = argument("--run-id");
  const requestedBatchId = argument("--batch-id");
  if (!runId && !requestedBatchId) throw new Error("Usage: npm run batch:import -- --run-id <Judge generation run id>");

  const runResult = await pool.query(
    `SELECT r.*, e.dataset_id, e.reference_run_id AS experiment_reference_run_id
       FROM eval_generation_runs r
       JOIN eval_experiments e ON e.id = r.experiment_id
      WHERE ${runId ? "r.id = $1" : "r.provider_batch_id = $1"}
        AND r.execution_mode = 'openai_batch'
        AND r.provider = 'openai'`,
    [runId ?? requestedBatchId],
  );
  if (!runResult.rowCount) throw new Error("OpenAI Batch generation run was not found");
  const run = runResult.rows[0] as JsonRecord;
  if (run.model !== MODEL) throw new Error(`Refusing to import model ${run.model}; required model is ${MODEL}`);
  if (!run.provider_batch_id) throw new Error("The Judge run has no provider_batch_id; submit the Batch first");
  if (requestedBatchId && requestedBatchId !== run.provider_batch_id) throw new Error("Requested Batch ID does not match the Judge run");

  const batch = await openAiJson(`/batches/${encodeURIComponent(run.provider_batch_id)}`);
  const status = providerStatus(batch.status);
  const timestamps = {
    submittedAt: dateFromUnix(batch.created_at),
    inProgressAt: dateFromUnix(batch.in_progress_at),
    finalizingAt: dateFromUnix(batch.finalizing_at),
    completedAt: dateFromUnix(batch.completed_at),
    failedAt: dateFromUnix(batch.failed_at),
    expiresAt: dateFromUnix(batch.expires_at),
  };
  const counts = record(batch.request_counts);
  const usage = record(batch.usage);
  await pool.query(
    `UPDATE eval_generation_runs
        SET status=$1, output_file_id=$2, error_file_id=$3,
            total_requests=$4, completed_requests=$5, failed_requests=$6,
            input_tokens=$7, output_tokens=$8, total_tokens=$9, cached_input_tokens=$10,
            reasoning_tokens=$11, submitted_at=COALESCE($12, submitted_at),
            in_progress_at=$13, finalizing_at=$14, completed_at=$15, failed_at=$16, expires_at=$17,
            metadata=COALESCE(metadata, '{}'::jsonb) || $18::jsonb, updated_at=NOW()
      WHERE id=$19`,
    [
      status,
      batch.output_file_id ?? null,
      batch.error_file_id ?? null,
      integer(counts.total) ?? run.total_requests,
      integer(counts.completed) ?? 0,
      integer(counts.failed) ?? 0,
      integer(usage.input_tokens),
      integer(usage.output_tokens),
      integer(usage.total_tokens),
      integer(usage.input_tokens_details?.cached_tokens),
      integer(usage.output_tokens_details?.reasoning_tokens),
      timestamps.submittedAt,
      timestamps.inProgressAt,
      timestamps.finalizingAt,
      timestamps.completedAt,
      timestamps.failedAt,
      timestamps.expiresAt,
      JSON.stringify({ openaiBatch: batch, lastImportedAt: new Date().toISOString() }),
      run.id,
    ],
  );

  if (status !== "completed") {
    console.log(JSON.stringify({ runId: run.id, batchId: run.provider_batch_id, status, requestCounts: counts }, null, 2));
    return;
  }
  const readBatchLines = async (fileId: unknown): Promise<JsonRecord[]> => {
    if (typeof fileId !== "string") return [];
    return (await openAiText(`/files/${encodeURIComponent(fileId)}/content`))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
  };
  const lines = [...await readBatchLines(batch.output_file_id), ...await readBatchLines(batch.error_file_id)];
  if (!lines.length) throw new Error("Completed Batch has no output or error result lines");
  const jobsResult = await pool.query(
    `SELECT j.id AS job_id, j.case_id, j.idempotency_key, c.case_key, c.prompt_version,
            p.custom_id, p.system_prompt_tokens,
            p.user_prompt_tokens, p.assistant_context_tokens,
            p.system_prompt_hash, p.user_prompt_hash
       FROM eval_jobs j
       JOIN eval_dataset_cases c ON c.id = j.case_id
       JOIN eval_prepared_requests p
         ON p.execution_run_id = $1 AND p.case_id = c.id
      WHERE j.experiment_id = $2
      ORDER BY c.case_key`,
    [run.id, run.experiment_id],
  );
  const jobs = new Map<string, JsonRecord>();
  for (const job of jobsResult.rows) jobs.set(String(job.custom_id), job as JsonRecord);
  if (jobs.size !== run.total_requests) throw new Error("Batch run does not have the expected Judge jobs");

  const client = await pool.connect();
  let inserted = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  try {
    await client.query("BEGIN");
    for (const line of lines) {
      const customId = String(line.custom_id ?? "");
      const job = jobs.get(customId);
      if (!job) throw new Error(`Unknown Batch custom_id: ${customId}`);
      const existing = await client.query(
        `SELECT tokens_prompt,tokens_completion,tokens_total,cost_usd,error,raw_output,
                system_prompt_tokens,user_prompt_tokens,assistant_context_tokens,
                tokens_accepted_prediction,tokens_rejected_prediction
           FROM eval_generations WHERE execution_run_id=$1 AND custom_id=$2 LIMIT 1`,
        [run.id, customId],
      );
      if (existing.rowCount) {
        const generation = existing.rows[0] as JsonRecord;
        const existingBody = record(record(record(generation.raw_output).response).body);
        const existingUsage = record(existingBody.usage);
        await client.query(
          `UPDATE eval_generations
              SET system_prompt_tokens=COALESCE(system_prompt_tokens,$1),
                  user_prompt_tokens=COALESCE(user_prompt_tokens,$2),
                  assistant_context_tokens=COALESCE(assistant_context_tokens,$3),
                  tokens_accepted_prediction=COALESCE(tokens_accepted_prediction,$4),
                  tokens_rejected_prediction=COALESCE(tokens_rejected_prediction,$5),
                  provider_request_id=COALESCE($6,provider_request_id)
            WHERE execution_run_id=$7 AND custom_id=$8`,
          [
            integer(job.system_prompt_tokens),
            integer(job.user_prompt_tokens),
            integer(job.assistant_context_tokens),
            integer(existingUsage.completion_tokens_details?.accepted_prediction_tokens),
            integer(existingUsage.completion_tokens_details?.rejected_prediction_tokens),
            typeof record(record(generation.raw_output).response).request_id === "string" ? record(record(generation.raw_output).response).request_id : null,
            run.id,
            customId,
          ],
        );
        if (generation.error !== null) failed++;
        inputTokens += Number(generation.tokens_prompt ?? 0);
        outputTokens += Number(generation.tokens_completion ?? 0);
        totalTokens += Number(generation.tokens_total ?? 0);
        totalCost += Number(generation.cost_usd ?? 0);
        continue;
      }

      const responseEnvelope = record(line.response);
      const responseBody = record(responseEnvelope.body);
      const statusCode = integer(responseEnvelope.status_code);
      const responseUsage = record(responseBody.usage);
      const parsed = parseAssistantContent(responseBody);
      const lineError = line.error ? JSON.stringify(line.error) : statusCode !== 200 ? `Batch status_code=${statusCode ?? "unknown"}` : parsed.parseError;
      const promptTokens = integer(responseUsage.prompt_tokens);
      const completionTokens = integer(responseUsage.completion_tokens);
      const total = integer(responseUsage.total_tokens);
      const cached = integer(responseUsage.prompt_tokens_details?.cached_tokens);
      const reasoning = integer(responseUsage.completion_tokens_details?.reasoning_tokens);
      const acceptedPrediction = integer(responseUsage.completion_tokens_details?.accepted_prediction_tokens);
      const rejectedPrediction = integer(responseUsage.completion_tokens_details?.rejected_prediction_tokens);
      const cost = costUsd(promptTokens, completionTokens);
      const startedAt = timestamps.inProgressAt ?? timestamps.submittedAt;
      const completedAt = timestamps.completedAt ?? timestamps.failedAt;
      const providerMetadata = {
        batchResultLine: line,
        // ponytail: omit the large prepared prompt body from this transfer; it remains in eval_prepared_requests.
        latencyMs: null,
        latencyUnavailableReason: "OpenAI Batch exposes batch lifecycle timestamps, not per-request latency.",
        batchSubmittedAt: timestamps.submittedAt?.toISOString() ?? null,
        batchCompletedAt: timestamps.completedAt?.toISOString() ?? null,
        costBasis: { inputPerMillion: BATCH_INPUT_PER_MILLION, outputPerMillion: BATCH_OUTPUT_PER_MILLION },
      };
      await client.query(
        `INSERT INTO eval_generations (
          job_id, execution_run_id, arm, execution_mode, provider, model, prompt_version,
          request_id, custom_id, provider_request_id, provider_batch_id, endpoint,
          raw_output, parsed_output, schema_valid, tokens_prompt, tokens_completion,
          tokens_total, tokens_cached, tokens_reasoning, tokens_accepted_prediction,
          tokens_rejected_prediction, system_prompt_tokens,
          user_prompt_tokens, assistant_context_tokens, latency_ms, cost_usd,
          prompt_hash, response_hash, response_character_count, started_at, completed_at,
          provider_metadata, error
        ) VALUES ($1,$2,'candidate','openai_batch','openai',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,
          $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31)`,
        [
          job.job_id,
          run.id,
          MODEL,
          job.prompt_version,
          customId,
          customId,
          typeof responseEnvelope.request_id === "string" ? responseEnvelope.request_id : null,
          run.provider_batch_id,
          run.endpoint,
          JSON.stringify(line),
          parsed.parsed === null ? null : JSON.stringify(parsed.parsed),
          lineError === null,
          promptTokens,
          completionTokens,
          total,
          cached,
          reasoning,
          acceptedPrediction,
          rejectedPrediction,
          integer(job.system_prompt_tokens),
          integer(job.user_prompt_tokens),
          integer(job.assistant_context_tokens),
          null,
          cost,
          job.system_prompt_hash ?? job.user_prompt_hash ?? null,
          parsed.content === null ? null : sha256(parsed.content),
          parsed.content?.length ?? null,
          startedAt,
          completedAt,
          JSON.stringify(providerMetadata),
          lineError,
        ],
      );
      await client.query("UPDATE eval_jobs SET status=$1,last_error=$2,completed_at=$3,updated_at=NOW() WHERE id=$4", [lineError === null ? "completed" : "failed", lineError, lineError === null ? completedAt : null, job.job_id]);
      inserted++;
      if (lineError !== null) failed++;
      if (promptTokens !== null) inputTokens += promptTokens;
      if (completionTokens !== null) outputTokens += completionTokens;
      if (total !== null) totalTokens += total;
      if (cost !== null) totalCost += cost;
    }
    if (lines.length !== run.total_requests) throw new Error(`Expected ${run.total_requests} Batch output lines, received ${lines.length}`);
    await client.query(
      `UPDATE eval_generation_runs
          SET status=$1, completed_requests=$2, failed_requests=$3,
              input_tokens=$4, output_tokens=$5, total_tokens=$6, cost_usd=$7,
              completed_at=COALESCE(completed_at,$8), metadata=COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
              updated_at=NOW()
        WHERE id=$10`,
      [failed ? "failed" : "completed", lines.length - failed, failed, inputTokens, outputTokens, totalTokens, totalCost, timestamps.completedAt, JSON.stringify({ importedOutputFileSha256: sha256(lines.map((line) => JSON.stringify(line)).join("\n")), importedLineCount: lines.length }), run.id],
    );
    await client.query("UPDATE eval_experiments SET status=$1,updated_at=NOW() WHERE id=$2", [failed ? "failed" : "completed", run.experiment_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ runId: run.id, batchId: run.provider_batch_id, outputFileId: batch.output_file_id, inserted, failed, inputTokens, outputTokens, totalTokens, costUsd: totalCost }, null, 2));
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => pool.end());
