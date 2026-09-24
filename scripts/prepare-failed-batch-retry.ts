import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pool } from "../server/db.js";

const MODEL = "gpt-5.6-sol";
const ENDPOINT = "/v1/chat/completions";
const EXPERIMENT_ID = process.argv[2];
const DATASET_VERSION = "GPT 5.6 SOL Dataset";
const SOURCE_RETRY_VERSION = process.argv[3];
const RETRY_VERSION = process.argv[4] ?? (SOURCE_RETRY_VERSION ? `${SOURCE_RETRY_VERSION}-2` : "retry-20260903");
const SOURCE_DIRECTORY = path.resolve(process.cwd(), "artifacts", "batches", DATASET_VERSION, SOURCE_RETRY_VERSION ?? "");
const ARTIFACT_DIRECTORY = path.join(SOURCE_DIRECTORY, RETRY_VERSION);
const MAX_BATCH_BYTES = 190_000_000;
const MAX_BATCH_LINES = 50_000;

type Row = {
  custom_id: string;
  case_id: string;
  provider: string;
  model: string;
  endpoint: string;
  prompt_version: string;
  request_body_checksum: string;
  system_prompt_tokens: number;
  user_prompt_tokens: number;
  assistant_context_tokens: number;
  prompt_character_count: number;
  system_prompt_hash: string | null;
  user_prompt_hash: string | null;
};

type RetryRow = Row & { retry_custom_id: string };

if (!EXPERIMENT_ID) throw new Error("Usage: tsx scripts/prepare-failed-batch-retry.ts <experiment-id>");

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function main() {
  const existing = await pool.query("SELECT id FROM eval_generation_runs WHERE experiment_id=$1 AND metadata->>'retryVersion'=$2", [EXPERIMENT_ID, RETRY_VERSION]);
  if (existing.rowCount) throw new Error(`${RETRY_VERSION} already exists; refusing to create duplicate retries`);

  const result = await pool.query(
    `SELECT DISTINCT ON (g.custom_id)
            g.custom_id,c.id AS case_id,p.provider,p.model,p.endpoint,p.prompt_version,p.request_body_checksum,
            p.system_prompt_tokens,p.user_prompt_tokens,p.assistant_context_tokens,p.prompt_character_count,
            p.system_prompt_hash,p.user_prompt_hash
       FROM eval_generations g
       JOIN eval_generation_runs r ON r.id=g.execution_run_id
       JOIN eval_jobs j ON j.id=g.job_id AND j.experiment_id=$1
       JOIN eval_dataset_cases c ON c.id=j.case_id
       JOIN eval_prepared_requests p ON p.execution_run_id=g.execution_run_id AND p.case_id=c.id AND p.custom_id=g.custom_id
      WHERE r.experiment_id=$1 AND ${SOURCE_RETRY_VERSION ? "r.metadata->>'retryVersion'=$2" : "r.metadata->>'partition' IS NOT NULL"}
        AND r.model=$${SOURCE_RETRY_VERSION ? "3" : "2"} AND r.provider='openai' AND r.execution_mode='openai_batch' AND g.error IS NOT NULL
      ORDER BY g.custom_id,g.created_at DESC`,
    SOURCE_RETRY_VERSION ? [EXPERIMENT_ID, SOURCE_RETRY_VERSION, MODEL] : [EXPERIMENT_ID, MODEL],
  );
  const rows = result.rows as Row[];
  if (!rows.length) throw new Error("No failed original batch lines found");
  const byCustomId = new Map(rows.map((row) => [row.custom_id, row]));
  const manifestPath = path.join(SOURCE_DIRECTORY, "manifest.json");
  const sources = SOURCE_RETRY_VERSION
    ? (await readdir(SOURCE_DIRECTORY)).filter((file) => file.endsWith(".jsonl")).sort().map((file, index) => ({ partition: index + 1, sha256: null, filePath: path.join(SOURCE_DIRECTORY, file) }))
    : (JSON.parse(await readFile(manifestPath, "utf8")) as { partitions: Array<{ partition: number; sha256: string }> }).partitions.map((source) => ({ ...source, filePath: path.join(SOURCE_DIRECTORY, `${DATASET_VERSION}.part-${String(source.partition).padStart(2, "0")}.jsonl`) }));
  const parts: Array<{ rows: RetryRow[]; contents: string }> = [];
  const found = new Set<string>();
  let current: RetryRow[] = [];
  let contents = "";
  let currentBytes = 0;
  for (const source of sources) {
    const sourceContents = await readFile(source.filePath, "utf8");
    if (source.sha256 && sha256(sourceContents) !== source.sha256) throw new Error(`Original partition ${source.partition} checksum changed`);
    for (const rawLine of sourceContents.trimEnd().split("\n")) {
      const customId = rawLine.match(/^\{"custom_id":"([^"\\]+)"/)?.[1];
      const row = customId ? byCustomId.get(customId) : undefined;
      if (!customId || !row) continue;
      if (!rawLine.startsWith(`{"custom_id":${JSON.stringify(customId)},"method":"POST","url":${JSON.stringify(ENDPOINT)},"body":`) || !rawLine.includes(`"model":${JSON.stringify(MODEL)}`)) throw new Error(`Invalid original request ${customId}`);
      if (found.has(customId)) throw new Error(`Duplicate original request ${customId}`);
      found.add(customId);
      const partition = parts.length + 1;
      let retryCustomId = `cg-retry-${RETRY_VERSION}-p${String(partition).padStart(2, "0")}:${customId}`;
      let retryLine = `${rawLine.replace(`"custom_id":${JSON.stringify(customId)}`, `"custom_id":${JSON.stringify(retryCustomId)}`)}\n`;
      const retryBytes = Buffer.byteLength(retryLine);
      if (current.length && (currentBytes + retryBytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_LINES)) {
        parts.push({ rows: current, contents });
        current = [];
        contents = "";
        currentBytes = 0;
        retryCustomId = `cg-retry-${RETRY_VERSION}-p${String(parts.length + 1).padStart(2, "0")}:${customId}`;
        retryLine = `${rawLine.replace(`"custom_id":${JSON.stringify(customId)}`, `"custom_id":${JSON.stringify(retryCustomId)}`)}\n`;
      }
      current.push({ ...row, retry_custom_id: retryCustomId });
      contents += retryLine;
      currentBytes += retryBytes;
    }
  }
  if (found.size !== rows.length) throw new Error(`Only found ${found.size}/${rows.length} failed requests in original artifacts`);
  if (current.length) parts.push({ rows: current, contents });
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  const files = parts.map((part, index) => ({ ...part, filePath: path.join(ARTIFACT_DIRECTORY, `${DATASET_VERSION}.${RETRY_VERSION}.part-${String(index + 1).padStart(2, "0")}.jsonl`) }));
  for (const file of files) await writeFile(file.filePath, file.contents, "utf8");

  const client = await pool.connect();
  const runIds: string[] = [];
  try {
    await client.query("BEGIN");
    for (const [index, file] of files.entries()) {
      const checksum = sha256(file.contents);
      const run = await client.query(
        `INSERT INTO eval_generation_runs
           (experiment_id,arm,execution_mode,provider,model,endpoint,prompt_version,status,completion_window,total_requests,metadata)
         VALUES ($1,'candidate','openai_batch','openai',$2,$3,'cg-production-current','pending','24h',$4,$5::jsonb) RETURNING id`,
        [EXPERIMENT_ID, MODEL, ENDPOINT, file.rows.length, JSON.stringify({ purpose: "failed_batch_retry", datasetVersion: DATASET_VERSION, retryVersion: RETRY_VERSION, retryPartition: index + 1, inputFilePath: file.filePath, localJsonlSha256: checksum, localJsonlBytes: Buffer.byteLength(file.contents), source: "exact failed lines from CG-prepared original requests" })],
      );
      const runId = run.rows[0].id as string;
      runIds.push(runId);
      const payload = JSON.stringify(file.rows.map((row) => ({ case_id: row.case_id, custom_id: row.custom_id, retry_custom_id: row.retry_custom_id })));
      const inserted = await client.query(
        `INSERT INTO eval_prepared_requests
           (execution_run_id,case_id,provider,model,endpoint,prompt_version,custom_id,request_body,request_body_checksum,
            system_prompt_tokens,user_prompt_tokens,assistant_context_tokens,prompt_character_count,system_prompt_hash,user_prompt_hash)
         SELECT $1,x.case_id,source.provider,source.model,source.endpoint,source.prompt_version,x.retry_custom_id,source.request_body,
                source.request_body_checksum,source.system_prompt_tokens,source.user_prompt_tokens,source.assistant_context_tokens,
                source.prompt_character_count,source.system_prompt_hash,source.user_prompt_hash
           FROM jsonb_to_recordset($2::jsonb) AS x(case_id uuid,custom_id text,retry_custom_id text)
           JOIN eval_prepared_requests source ON source.case_id=x.case_id AND source.custom_id=x.custom_id
          WHERE source.model=$3 AND source.endpoint=$4 RETURNING id`,
        [runId, payload, MODEL, ENDPOINT],
      );
      if (inserted.rowCount !== file.rows.length) throw new Error(`Retry partition ${index + 1} inserted ${inserted.rowCount}/${file.rows.length} prepared rows`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ retryVersion: RETRY_VERSION, totalFailedLines: rows.length, partitions: files.map((file, index) => ({ partition: index + 1, runId: runIds[index], requestCount: file.rows.length, bytes: Buffer.byteLength(file.contents), sha256: sha256(file.contents), filePath: file.filePath })) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => pool.end());
