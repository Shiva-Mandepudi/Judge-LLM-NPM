import "dotenv/config";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import OpenAI from "../../CosmicGuidance/node_modules/openai/index.js";
import { pool } from "../server/db.js";

const MODEL = "gpt-5.6-sol";

type JsonRecord = Record<string, any>;


function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}


function validateJsonl(contents: Buffer, expectedRequests: number, expectedSha256: string | null): void {
  if (expectedSha256 && sha256(contents) !== expectedSha256) throw new Error("Batch JSONL checksum does not match the prepared Judge run");
  const lines = contents.toString("utf8").trimEnd().split("\n");
  if (lines.length !== expectedRequests) throw new Error(`Batch JSONL has ${lines.length} lines; expected ${expectedRequests}`);
  const customIds = new Set<string>();
  for (const line of lines) {
    const request = JSON.parse(line) as JsonRecord;
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" || request.body?.model !== MODEL || typeof request.custom_id !== "string" || !request.custom_id) {
      throw new Error("Batch JSONL contains an invalid or non-gpt-5.6-sol request");
    }
    if (customIds.has(request.custom_id)) throw new Error(`Duplicate Batch custom_id: ${request.custom_id}`);
    customIds.add(request.custom_id);
  }
}

async function main() {
  const runId = argument("--run-id");
  if (!runId) throw new Error("Usage: npm run batch:submit -- --run-id <Judge generation run id>");

  const result = await pool.query(
    `SELECT id, model, status, total_requests, provider_batch_id, input_file_id, metadata
       FROM eval_generation_runs
      WHERE id=$1 AND execution_mode='openai_batch' AND provider='openai'`,
    [runId],
  );
  if (!result.rowCount) throw new Error("Prepared OpenAI Batch run was not found");
  const run = result.rows[0] as JsonRecord;
  if (run.model !== MODEL) throw new Error(`Refusing to submit model ${run.model}; required model is ${MODEL}`);
  if (run.provider_batch_id) throw new Error("This Judge run is already submitted to OpenAI Batch");
  if (run.input_file_id) throw new Error("This Judge run has an uploaded input file but no Batch ID; resolve that recorded state before retrying");
  if (run.status !== "pending") throw new Error(`Only pending Judge runs can be submitted; current status is ${run.status}`);

  const metadata = record(run.metadata);
  const inputFilePath = typeof metadata.inputFilePath === "string" ? metadata.inputFilePath : null;
  const expectedSha256 = typeof metadata.localJsonlSha256 === "string" ? metadata.localJsonlSha256 : null;
  if (!inputFilePath) throw new Error("Prepared Judge run has no local JSONL path");
  const contents = await readFile(inputFilePath);
  validateJsonl(contents, Number(run.total_requests), expectedSha256);

  const organization = process.env.OPENAI_ORGANIZATION?.trim();
  const project = process.env.OPENAI_PROJECT?.trim();
  if (!organization || !project) throw new Error("OPENAI_ORGANIZATION and OPENAI_PROJECT must be configured");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, organization, project });
  const file = await client.files.create({ file: createReadStream(inputFilePath), purpose: "batch" });
  const batch = await client.batches.create({ input_file_id: file.id, endpoint: "/v1/chat/completions", completion_window: "24h", metadata: { judge_generation_run_id: runId, model: MODEL, purpose: "cg-batch-corpus" } });

  await pool.query(
    `UPDATE eval_generation_runs
        SET status='submitted', input_file_id=$1, provider_batch_id=$2, submitted_at=NOW(),
            metadata=COALESCE(metadata,'{}'::jsonb) || $3::jsonb, updated_at=NOW()
      WHERE id=$4 AND provider_batch_id IS NULL`,
    [file.id, batch.id, JSON.stringify({ openaiBatch: batch, submittedJsonlSha256: sha256(contents) }), runId],
  );
  console.log(JSON.stringify({ runId, batchId: batch.id, inputFileId: file.id, status: batch.status, requestCount: run.total_requests }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => pool.end());
