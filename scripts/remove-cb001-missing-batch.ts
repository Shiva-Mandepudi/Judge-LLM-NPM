import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pool } from "../server/db.js";

const DATASET_ID = "30b87fb3-33df-4495-98cf-ee4b4d48abb4";
const EXPERIMENT_ID = "a37e7abf-f4b4-4f4c-b238-f62e5660d5d9";
const MODEL = "gpt-5.6-sol";
const DATASET_VERSION = "cg-production-batch-only-20260828";
const DIRECTORY = path.resolve(process.cwd(), "artifacts", "batches", DATASET_VERSION);
const PARTITION = 1;
const FILE_PATH = path.join(DIRECTORY, `${DATASET_VERSION}.part-01.jsonl`);
const MANIFEST_PATH = path.join(DIRECTORY, "manifest.json");

const sha256 = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const caseKeyFromCustomId = (customId: string) => customId.split(":").slice(1, -1).join(":");

const cases = (await pool.query(
  `SELECT id,case_key FROM eval_dataset_cases
    WHERE dataset_id=$1 AND case_key LIKE 'cb-actor-001:%'
      AND track IN ('numerology','zodiac_profile','universal_insights')
    ORDER BY case_key`, [DATASET_ID],
)).rows as Array<{ id: string; case_key: string }>;
if (cases.length !== 14) throw new Error(`Expected 14 cb-actor-001 missing cases, found ${cases.length}`);
const caseKeys = new Set(cases.map((row) => row.case_key));
const caseIds = cases.map((row) => row.id);

const original = await readFile(FILE_PATH);
const originalLines = original.toString("utf8").trimEnd().split("\n");
const kept: string[] = [];
const removed: string[] = [];
const customIds = new Set<string>();
for (const line of originalLines) {
  const request = JSON.parse(line) as Record<string, any>;
  const customId = typeof request.custom_id === "string" ? request.custom_id : "";
  const matchingCase = [...caseKeys].find((caseKey) => customId.includes(`:${caseKey}:`));
  if (matchingCase) {
    removed.push(matchingCase);
    continue;
  }
  if (!customId || customIds.has(customId)) throw new Error(`Invalid or duplicate remaining custom_id: ${customId}`);
  if (request.method !== "POST" || request.url !== "/v1/chat/completions" || request.body?.model !== MODEL) throw new Error("Invalid remaining Batch request");
  customIds.add(customId);
  kept.push(line);
}
if (new Set(removed).size !== 14 || removed.length !== 14) throw new Error(`Removed ${removed.length} matching lines, expected exactly 14`);
const updatedContents = Buffer.from(`${kept.join("\n")}\n`, "utf8");
const updatedChecksum = sha256(updatedContents);
const tempPath = `${FILE_PATH}.tmp-${process.pid}`;
await writeFile(tempPath, updatedContents);

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Record<string, any>;
const partition = (manifest.partitions as Array<Record<string, any>>).find((item) => item.partition === PARTITION);
if (!partition || partition.runId !== "92c28246-7504-4c89-a2da-b54abce7d5a9") throw new Error("Partition 1 manifest does not match the prepared Judge run");
partition.requestCount = kept.length;
partition.byteCount = updatedContents.byteLength;
partition.sha256 = updatedChecksum;
const remainingRequests = Number(manifest.aiRequests) - removed.length;
if (remainingRequests !== 2526) throw new Error(`Unexpected remaining Batch request count: ${remainingRequests}`);
manifest.aiRequests = remainingRequests;
partition.firstCaseKey = caseKeyFromCustomId(JSON.parse(kept[0]).custom_id);
partition.lastCaseKey = caseKeyFromCustomId(JSON.parse(kept.at(-1)!).custom_id);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const prepared = await client.query(
    `SELECT p.id,p.execution_run_id
       FROM eval_prepared_requests p
       JOIN eval_generation_runs r ON r.id=p.execution_run_id
      WHERE r.experiment_id=$1 AND r.execution_mode='openai_batch' AND p.case_id=ANY($2::uuid[])
      FOR UPDATE`, [EXPERIMENT_ID, caseIds],
  );
  if (prepared.rowCount !== 14) throw new Error(`Judge has ${prepared.rowCount} prepared rows for these cases, expected 14`);
  await client.query("DELETE FROM eval_prepared_requests WHERE id=ANY($1::uuid[])", [prepared.rows.map((row) => row.id)]);
  const runIds = [...new Set(prepared.rows.map((row) => row.execution_run_id))];
  for (const runId of runIds) {
    const count = await client.query("SELECT COUNT(*)::int AS count FROM eval_prepared_requests WHERE execution_run_id=$1", [runId]);
    const metadata = runId === partition.runId
      ? { localJsonlSha256: updatedChecksum, localJsonlBytes: updatedContents.byteLength }
      : {};
    await client.query(
      `UPDATE eval_generation_runs
          SET total_requests=$1,metadata=COALESCE(metadata,'{}'::jsonb) || $2::jsonb,updated_at=NOW()
        WHERE id=$3`, [count.rows[0].count, JSON.stringify(metadata), runId],
    );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  await rename(tempPath, `${FILE_PATH}.recovery-${process.pid}`).catch(() => undefined);
  throw error;
} finally {
  client.release();
}

await rename(tempPath, FILE_PATH);
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ removed: removed.length, remainingPartitionRequests: kept.length, remainingBatchRequests: remainingRequests, filePath: FILE_PATH, sha256: updatedChecksum }, null, 2));
await pool.end();
