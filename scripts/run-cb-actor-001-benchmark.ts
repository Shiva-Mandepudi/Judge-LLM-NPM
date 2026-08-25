import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pool } from "../server/db.js";
import { resolveSecret } from "../server/lib/secrets.js";
import { requestGeneration } from "../server/services/generation-client.js";

const MODEL = "gpt-5.6-sol";
const PROMPT_VERSION = "cg-production-current";
const DATASET_TRACK = "brief_readings";
const DATASET_VERSION = "cb-actor-001-20260824";
const TRANSIT_DATE = "2026-08-24";
const BATCH_FILE = path.resolve(process.cwd(), "artifacts/batches", `${DATASET_VERSION}.jsonl`);
const COST_INPUT_PER_MILLION = 4;
const COST_OUTPUT_PER_MILLION = 20;
const RESUME = process.argv.includes("--resume");
const EXPECTED_CASE_COUNT = 12;

type Person = {
  datasetId: string;
  name: string;
  gender: string;
  date: string;
  city: string;
  country: string;
  time: string;
  timezone: string;
  latitude?: number;
  longitude?: number;
};

type CaseDef = {
  caseKey: string;
  track: string;
  readingType: string;
  readingSubtype: string;
  subjectKey: string;
  inputSnapshot: Record<string, unknown>;
  tags: string[];
};

type CaseRow = CaseDef & { id: string };

const actor: Person = {
  datasetId: "cb-actor-001",
  name: "Nandamuri Taraka Rama Rao Jr.",
  gender: "Male",
  date: "1983-05-20",
  city: "Hyderabad",
  country: "India",
  time: "02:29:00",
  timezone: "Asia/Kolkata",
  latitude: 17.361667,
  longitude: 78.474722,
};

const partner: Person = {
  datasetId: "supplied-partner-nandamuri-lakshmi-pranathi",
  name: "Nandamuri Lakshmi Pranathi",
  gender: "Female",
  date: "1992-03-26",
  city: "Hyderabad",
  country: "India",
  time: "12:00:00",
  timezone: "Asia/Kolkata",
};

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function estimatedCost(usage: Record<string, unknown>): number | null {
  const input = Number(usage.promptTokens ?? 0);
  const output = Number(usage.completionTokens ?? 0);
  return Number.isFinite(input) && Number.isFinite(output)
    ? (input * COST_INPUT_PER_MILLION + output * COST_OUTPUT_PER_MILLION) / 1_000_000
    : null;
}

async function calcSnapshot(calcInputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const baseUrl = process.env.COSMIC_GUIDANCE_INTERNAL_BASE_URL;
  const secretRef = process.env.JUDGE_TO_CG_SHARED_SECRET_REF;
  if (!baseUrl || !secretRef) throw new Error("CG URL and Judge-to-CG secret reference are required");
  const secret = await resolveSecret(secretRef);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/judge/calc-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-judge-shared-secret": secret },
    body: JSON.stringify({ calcInputs }),
  });
  if (!response.ok) throw new Error(`CG calculation failed (${response.status}): ${await response.text()}`);
  return (await response.json() as { inputSnapshot: Record<string, unknown> }).inputSnapshot;
}

async function numerologyProfile(person: Person) {
  const values: Record<string, number> = {};
  for (const [numberType, key] of [
    ["life_path", "lifePathNumber"],
    ["expression", "expressionNumber"],
    ["soul_urge", "soulUrgeNumber"],
    ["personality", "personalityNumber"],
  ] as const) {
    const snapshot = await calcSnapshot({ numberType, insightType: "detailed", birthDate: person.date, fullName: person.name });
    values[key] = Number(snapshot.numberValue);
  }
  return { name: person.name, ...values };
}

async function prepareCases(): Promise<CaseDef[]> {
  const natal = await calcSnapshot({ chartType: "natal", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country } });
  const transit = await calcSnapshot({ chartType: "transit", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country }, transitDate: TRANSIT_DATE, transitTime: "12:00" });
  const synastry = await calcSnapshot({ chartType: "synastry", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country }, partnerName: partner.name, partnerDate: partner.date, partnerTime: partner.time, partnerLocation: { city: partner.city, nation: partner.country } });
  const composite = await calcSnapshot({ chartType: "composite", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country }, partnerName: partner.name, partnerDate: partner.date, partnerTime: partner.time, partnerLocation: { city: partner.city, nation: partner.country } });
  const actorNumbers = await numerologyProfile(actor);
  const partnerNumbers = await numerologyProfile(partner);
  const tarot = {
    spreadType: "three-card",
    question: "What do I need to understand about the past, present, and future of my current life journey?",
    cards: [
      { name: "The Hermit", isReversed: false, position: "Past" },
      { name: "The Chariot", isReversed: false, position: "Present" },
      { name: "The World", isReversed: false, position: "Future" },
    ],
  };
  const cases: CaseDef[] = [];
  const add = (track: string, readingType: string, inputSnapshot: Record<string, unknown>, tags: string[]) => {
    for (const insightType of ["detailed", "brief"] as const) {
      cases.push({
        caseKey: `cb-actor-001:${readingType}:${insightType}`,
        track,
        readingType,
        readingSubtype: insightType,
        subjectKey: actor.datasetId,
        inputSnapshot: { ...inputSnapshot, insightType },
        tags: [...tags, insightType],
      });
    }
  };
  add("natal", "natal", natal, ["natal"]);
  add("transit", "transit", { ...transit, transitDate: TRANSIT_DATE }, ["transit"]);
  add("tarot", "tarot", tarot, ["tarot", "traditional_three_card"]);
  add("synastry", "synastry", { ...synastry, readingType: "synastry", person1Name: actor.name, person2Name: partner.name }, ["synastry", "compatibility"]);
  add("composite", "composite", { ...composite, readingType: "composite", person1Name: actor.name, person2Name: partner.name }, ["composite", "compatibility"]);
  add("number_compatibility", "number_compatibility", { person1: actorNumbers, person2: partnerNumbers }, ["number_compatibility", "compatibility"]);
  return cases;
}

async function insertBenchmark(cases?: CaseDef[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM eval_datasets WHERE track = $1 AND version = $2", [DATASET_TRACK, DATASET_VERSION]);
    if (existing.rowCount) {
      if (!RESUME) throw new Error(`Dataset ${DATASET_TRACK}/${DATASET_VERSION} already exists; use --resume to continue it without duplicating requests`);
      const datasetId = existing.rows[0].id as string;
      const reference = await client.query("SELECT id,status FROM eval_reference_runs WHERE dataset_id=$1 ORDER BY created_at DESC LIMIT 1", [datasetId]);
      const experiment = await client.query("SELECT id,reference_run_id FROM eval_experiments WHERE dataset_id=$1 ORDER BY created_at DESC LIMIT 1", [datasetId]);
      if (!reference.rowCount || !experiment.rowCount) throw new Error("Existing benchmark dataset is incomplete; refusing to guess missing run ownership");
      const batchRun = await client.query("SELECT id,provider_batch_id FROM eval_generation_runs WHERE experiment_id=$1 AND execution_mode='openai_batch' ORDER BY created_at DESC LIMIT 1", [experiment.rows[0].id]);
      if (!batchRun.rowCount || batchRun.rows[0].provider_batch_id) throw new Error("Existing benchmark has already submitted Batch work; use batch:import instead of --resume");
      const caseResult = await client.query("SELECT id,case_key,track,reading_type,reading_subtype,subject_id,input_snapshot,tags FROM eval_dataset_cases WHERE dataset_id=$1 ORDER BY case_key", [datasetId]);
      if (caseResult.rowCount !== (cases?.length ?? EXPECTED_CASE_COUNT)) throw new Error("Existing benchmark case count differs from the requested benchmark");
      const subjectResult = await client.query("SELECT id,subject_key FROM eval_dataset_subjects WHERE dataset_id=$1", [datasetId]);
      const subjectById = new Map(subjectResult.rows.map((row) => [row.id as string, row.subject_key as string]));
      const standardRun = await client.query("SELECT id FROM eval_generation_runs WHERE reference_run_id=$1 AND execution_mode='cg_standard' ORDER BY created_at DESC LIMIT 1", [reference.rows[0].id]);
      if (!standardRun.rowCount) throw new Error("Existing benchmark has no CG Standard run");
      await client.query("UPDATE eval_generation_runs SET status='in_progress',failed_requests=0,failed_at=NULL,updated_at=NOW() WHERE id=$1", [standardRun.rows[0].id]);
      await client.query("UPDATE eval_reference_runs SET status='generating',failed_count=0 WHERE id=$1", [reference.rows[0].id]);
      await client.query("UPDATE eval_experiments SET status='running',updated_at=NOW() WHERE id=$1", [experiment.rows[0].id]);
      await client.query("COMMIT");
      return {
        datasetId,
        referenceRunId: reference.rows[0].id as string,
        experimentId: experiment.rows[0].id as string,
        standardRunId: standardRun.rows[0].id as string,
        batchRunId: batchRun.rows[0].id as string,
        rows: caseResult.rows.map((row) => ({
          id: row.id as string,
          caseKey: row.case_key as string,
          track: row.track as string,
          readingType: row.reading_type as string,
          readingSubtype: row.reading_subtype as string,
          subjectKey: subjectById.get(row.subject_id as string) ?? "",
          inputSnapshot: row.input_snapshot as Record<string, unknown>,
          tags: row.tags as string[],
        })),
      };
    }
    if (!cases) throw new Error("A new benchmark requires generated cases");
    const sourceChecksum = sha256(cases);
    const dataset = await client.query(
      "INSERT INTO eval_datasets (track, version, description, source_checksum, case_count, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [DATASET_TRACK, DATASET_VERSION, "cb-actor-001 Standard vs OpenAI Batch benchmark", sourceChecksum, cases.length, "cb-actor-001-benchmark"],
    );
    const datasetId = dataset.rows[0].id as string;
    const subjectIds = new Map<string, string>();
    for (const subject of [actor, partner]) {
      const result = await client.query(
        "INSERT INTO eval_dataset_subjects (dataset_id, subject_key, source_reference_hash, subject_snapshot, subject_checksum, metadata) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb) RETURNING id",
        [datasetId, subject.datasetId, sha256(subject.datasetId), JSON.stringify(subject), sha256(subject), JSON.stringify({ sourceFile: "AB Dataset.xlsx", sourceSheet: "100 Actors" })],
      );
      subjectIds.set(subject.datasetId, result.rows[0].id as string);
    }
    const rows: CaseRow[] = [];
    for (const item of cases) {
      const result = await client.query(
        "INSERT INTO eval_dataset_cases (dataset_id, subject_id, case_key, track, input_snapshot, prompt_version, tags, reading_type, reading_subtype, input_checksum, schema_version, calculator_version, provenance) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id",
        [datasetId, subjectIds.get(item.subjectKey), item.caseKey, item.track, JSON.stringify(item.inputSnapshot), PROMPT_VERSION, JSON.stringify(item.tags), item.readingType, item.readingSubtype, sha256(item.inputSnapshot), "cg-production-json", "cg-astroverse-current", JSON.stringify({ source: "cosmic_guidance_internal_api", sourceFile: "AB Dataset.xlsx", sourceSheet: "100 Actors" })],
      );
      rows.push({ ...item, id: result.rows[0].id as string });
    }
    const reference = await client.query(
      "INSERT INTO eval_reference_runs (dataset_id,name,provider,model,execution_mode,endpoint,prompt_version,schema_version,calculator_version,dataset_checksum,generation_config,status,case_count,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) RETURNING id",
      [datasetId, "CG Standard gpt-5.6-sol reference", "cosmic_guidance", MODEL, "cg_standard", "/api/internal/judge/generate", PROMPT_VERSION, "cg-production-json", "cg-astroverse-current", sourceChecksum, JSON.stringify({ model: MODEL, temperature: 0.7, source: "CG production prompt path" }), "generating", rows.length, "cb-actor-001-benchmark"],
    );
    const referenceRunId = reference.rows[0].id as string;
    const config = await client.query("SELECT id FROM eval_config_versions WHERE config_key = 'global' ORDER BY version DESC LIMIT 1");
    if (!config.rowCount) throw new Error("No Judge global config exists");
    const experiment = await client.query(
      "INSERT INTO eval_experiments (name,track,dataset_id,baseline_model,candidate_model,baseline_prompt_version,candidate_prompt_version,config_version_id,reference_run_id,comparison_type,baseline_execution_mode,candidate_execution_mode,created_by,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id",
      ["cb-actor-001 CG Standard vs OpenAI Batch", DATASET_TRACK, datasetId, MODEL, MODEL, PROMPT_VERSION, PROMPT_VERSION, config.rows[0].id, referenceRunId, "execution_mode", "cg_standard", "openai_batch", "cb-actor-001-benchmark", "running"],
    );
    const experimentId = experiment.rows[0].id as string;
    for (const row of rows) await client.query("INSERT INTO eval_jobs (experiment_id,case_id,idempotency_key,status) VALUES ($1,$2,$3,'pending')", [experimentId, row.id, `${DATASET_VERSION}:${row.caseKey}`]);
    const standardRun = await client.query("INSERT INTO eval_generation_runs (reference_run_id,execution_mode,provider,model,endpoint,prompt_version,status,total_requests) VALUES ($1,'cg_standard','cosmic_guidance',$2,'/api/internal/judge/generate',$3,'in_progress',$4) RETURNING id", [referenceRunId, MODEL, PROMPT_VERSION, rows.length]);
    const batchRun = await client.query("INSERT INTO eval_generation_runs (experiment_id,arm,execution_mode,provider,model,endpoint,prompt_version,status,total_requests) VALUES ($1,'candidate','openai_batch','openai',$2,'/v1/chat/completions',$3,'pending',$4) RETURNING id", [experimentId, MODEL, PROMPT_VERSION, rows.length]);
    await client.query("COMMIT");
    return { datasetId, referenceRunId, experimentId, standardRunId: standardRun.rows[0].id as string, batchRunId: batchRun.rows[0].id as string, rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function runStandard(benchmark: Awaited<ReturnType<typeof insertBenchmark>>) {
  const retryPolicy = { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1 };
  let completed = Number((await pool.query("SELECT count(*) FROM eval_reference_generations WHERE reference_run_id=$1", [benchmark.referenceRunId])).rows[0].count);
  try {
    for (const row of benchmark.rows) {
      const existing = await pool.query("SELECT 1 FROM eval_reference_generations WHERE reference_run_id=$1 AND case_id=$2 LIMIT 1", [benchmark.referenceRunId, row.id]);
      if (existing.rowCount) continue;
      const startedAt = new Date();
      const requestId = `${DATASET_VERSION}:${row.caseKey}:standard`;
      const response = await requestGeneration({
        track: row.track,
        arm: "baseline",
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        inputSnapshot: row.inputSnapshot,
        requestId,
      }, retryPolicy);
      const artifact = response.requestArtifact;
      if (response.model !== MODEL || !artifact) throw new Error(`CG response for ${row.caseKey} did not return the required ${MODEL} artifact`);
      if (artifact.requestBody.model !== MODEL || artifact.endpoint !== "/v1/chat/completions") throw new Error(`CG request artifact mismatch for ${row.caseKey}`);
      const providerMetadata = artifact.providerMetadata as Record<string, unknown>;
      const usage = response.usage;
      await pool.query(
        `INSERT INTO eval_reference_generations (
          reference_run_id, case_id, execution_run_id, provider, model, execution_mode,
          prompt_version, request_id, provider_request_id, raw_output, parsed_output,
          schema_valid, tokens_prompt, tokens_completion, tokens_total, tokens_cached,
          tokens_reasoning, tokens_accepted_prediction, tokens_rejected_prediction,
          system_prompt_tokens, user_prompt_tokens, assistant_context_tokens, latency_ms,
          cost_usd, prompt_hash, response_hash, response_character_count, started_at,
          completed_at, provider_metadata, error
        ) VALUES ($1,$2,$3,'cosmic_guidance',$4,'cg_standard',$5,$6,$7,$8::jsonb,$9::jsonb,
          $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29)`,
        [
          benchmark.referenceRunId,
          row.id,
          benchmark.standardRunId,
          MODEL,
          PROMPT_VERSION,
          requestId,
          stringValue(providerMetadata.providerRequestId),
          JSON.stringify({ text: artifact.responseText, responseMetadata: providerMetadata }),
          JSON.stringify(response.output),
          response.schemaValid,
          usage.promptTokens,
          usage.completionTokens,
          usage.totalTokens,
          usage.cachedPromptTokens ?? null,
          usage.reasoningTokens ?? null,
          usage.acceptedPredictionTokens ?? null,
          usage.rejectedPredictionTokens ?? null,
          artifact.systemPromptTokens,
          artifact.userPromptTokens,
          artifact.assistantContextTokens,
          response.latencyMs,
          estimatedCost(usage),
          artifact.systemPromptHash,
          hashText(artifact.responseText),
          artifact.responseText.length,
          startedAt,
          new Date(),
          JSON.stringify({
            requestBody: artifact.requestBody,
            responseUsage: artifact.usage,
            providerMetadata,
            promptCharacterCount: artifact.promptCharacterCount,
            userPromptHash: artifact.userPromptHash,
            costBasis: { inputPerMillion: COST_INPUT_PER_MILLION, outputPerMillion: COST_OUTPUT_PER_MILLION },
          }),
          response.error,
        ],
      );
      completed++;
      console.log(`Standard stored ${completed}/${benchmark.rows.length}: ${row.caseKey}`);
    }
    await pool.query("UPDATE eval_generation_runs SET status='completed',completed_requests=$1,completed_at=NOW(),updated_at=NOW() WHERE id=$2", [completed, benchmark.standardRunId]);
    await pool.query("UPDATE eval_reference_runs SET status='frozen',completed_count=$1,frozen_at=NOW() WHERE id=$2", [completed, benchmark.referenceRunId]);
  } catch (error) {
    await pool.query("UPDATE eval_generation_runs SET status='failed',completed_requests=$1,failed_requests=$2,failed_at=NOW(),updated_at=NOW() WHERE id=$3", [completed, benchmark.rows.length - completed, benchmark.standardRunId]);
    await pool.query("UPDATE eval_reference_runs SET status='failed',failed_count=$1 WHERE id=$2", [benchmark.rows.length - completed, benchmark.referenceRunId]);
    throw error;
  }
}

async function openAiJson(endpoint: string, init: RequestInit): Promise<any> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`https://api.openai.com/v1${endpoint}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI ${endpoint} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function submitBatch(benchmark: Awaited<ReturnType<typeof insertBenchmark>>) {
  const result = await pool.query(
    "SELECT c.case_key,g.provider_metadata FROM eval_reference_generations g JOIN eval_dataset_cases c ON c.id=g.case_id WHERE g.reference_run_id=$1 ORDER BY c.case_key",
    [benchmark.referenceRunId],
  );
  if (result.rowCount !== benchmark.rows.length) throw new Error("Cannot create Batch input until every Standard case is stored");
  const lines = result.rows.map((row) => {
    const metadata = row.provider_metadata as { requestBody?: Record<string, unknown> };
    if (!metadata.requestBody || metadata.requestBody.model !== MODEL) throw new Error(`Missing exact request body for ${row.case_key}`);
    return JSON.stringify({
      custom_id: `${DATASET_VERSION}:${row.case_key}:batch`,
      method: "POST",
      url: "/v1/chat/completions",
      body: metadata.requestBody,
    });
  });
  await mkdir(path.dirname(BATCH_FILE), { recursive: true });
  const contents = `${lines.join("\n")}\n`;
  await writeFile(BATCH_FILE, contents, "utf8");
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([await readFile(BATCH_FILE)], { type: "application/jsonl" }), path.basename(BATCH_FILE));
  const file = await openAiJson("/files", { method: "POST", body: form });
  const batch = await openAiJson("/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      metadata: { benchmark: DATASET_VERSION, model: MODEL },
    }),
  });
  await pool.query(
    "UPDATE eval_generation_runs SET status='submitted',provider_batch_id=$1,input_file_id=$2,submitted_at=NOW(),metadata=$3::jsonb,updated_at=NOW() WHERE id=$4",
    [batch.id, file.id, JSON.stringify({ inputFilePath: BATCH_FILE, inputFileSha256: hashText(contents), batchFileLineCount: lines.length, openaiBatch: batch }), benchmark.batchRunId],
  );
  console.log(JSON.stringify({
    datasetId: benchmark.datasetId,
    referenceRunId: benchmark.referenceRunId,
    experimentId: benchmark.experimentId,
    standardRunId: benchmark.standardRunId,
    batchRunId: benchmark.batchRunId,
    batchId: batch.id,
    inputFileId: file.id,
    batchFile: BATCH_FILE,
  }, null, 2));
}

async function main() {
  const benchmark = RESUME
    ? await insertBenchmark()
    : await insertBenchmark(await prepareCases());
  await runStandard(benchmark);
  await submitBatch(benchmark);
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => pool.end());
