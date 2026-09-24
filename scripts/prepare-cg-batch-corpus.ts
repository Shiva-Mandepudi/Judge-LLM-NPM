import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
// @ts-expect-error JSZip is owned by the adjacent Cosmic Guidance workspace.
import JSZip from "../../CosmicGuidance/node_modules/jszip/lib/index.js";
import { pool } from "../server/db.js";
import { resolveSecret } from "../server/lib/secrets.js";

const MODEL = "gpt-5.6-sol";
const DATASET_TRACK = "cg_batch_corpus";
const DATASET_VERSION = "GPT 5.6 SOL Dataset";
const PROMPT_VERSION = "cg-production-current";
const TRANSIT_DATE = "2026-08-28";
const TAROT_QUESTION = "What do I need to understand about the past, present, and future of my current life journey?";
const TAROT_CARDS = [
  { name: "The Hermit", isReversed: false, position: "Past" },
  { name: "The Chariot", isReversed: false, position: "Present" },
  { name: "The World", isReversed: false, position: "Future" },
];
const MAX_BATCH_BYTES = 190_000_000;
const MAX_BATCH_LINES = 50_000;
const RESUME = process.argv.includes("--resume");
const ARTIFACT_DIRECTORY = path.resolve(process.cwd(), "artifacts", "batches", DATASET_VERSION);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

type Person = {
  datasetId: string;
  name: string;
  gender: string;
  date: string;
  city: string;
  country: string;
  time: string;
  timezone: string;
  latitude: number;
  longitude: number;
  relation?: string;
  provenance?: Record<string, unknown>;
};

type CaseDefinition = {
  caseKey: string;
  track: string;
  readingType: string;
  readingSubtype: string;
  inputSnapshot: Record<string, unknown>;
  tags: string[];
};

type PreparedRow = {
  id: string;
  case_key: string;
  custom_id: string;
  request_body: Record<string, unknown>;
  request_body_checksum: string;
};

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCalculationArtifact(readingType: string, output: Record<string, unknown>): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(output)) as Record<string, any>;
  // This value is an execution timestamp, not calculated reading content.
  if (readingType === "cosmic_wheel") delete normalized.staticProfile?.lastCalculated;
  return normalized;
}

function fullNameParts(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

function normalizeWorkbookDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 1 || serial > 100_000) throw new Error(`Invalid workbook date: ${value}`);
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

function normalizeWorkbookTime(value: string): string {
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  if (/^\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error(`Invalid workbook time: ${value}`);
  const seconds = Math.round(fraction * 86_400) % 86_400;
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

function assignedBenchmarkTime(seed: string): string {
  const seconds = (crypto.createHash("sha256").update(seed).digest().readUInt32BE(0) % 86_399) + 1;
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

function integerActorNumber(datasetId: string): number {
  const matched = /^cb-actor-(\d{3})$/.exec(datasetId);
  if (!matched) throw new Error(`Invalid dataset actor ID: ${datasetId}`);
  return Number(matched[1]);
}

function xmlDecode(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function loadActors(): Promise<Array<{ actor: Person; partner: Person | null }>> {
  const workbookPath = path.resolve(process.cwd(), "..", "AB Dataset.xlsx");
  const zip = await JSZip.loadAsync(await readFile(workbookPath));
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const sharedStrings = [...(await zip.file("xl/sharedStrings.xml")!.async("string")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) => xmlDecode(item[1]));
  const cell = (row: number, column: string): string => {
    const match = sheet.match(new RegExp(`<c\\b([^>]*)\\br="${column}${row}"([^>]*)>([\\s\\S]*?)<\\/c>`));
    if (!match) throw new Error(`Workbook cell ${column}${row} is missing`);
    const value = match[3].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? match[3].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
    if (value === undefined) throw new Error(`Workbook cell ${column}${row} has no value`);
    if (/\bt="s"/.test(`${match[1]} ${match[2]}`)) {
      const shared = sharedStrings[Number(value)];
      if (shared === undefined) throw new Error(`Workbook shared string ${value} is missing`);
      return shared;
    }
    return xmlDecode(value);
  };
  const actors: Array<{ actor: Person; partner: Person | null }> = [];
  for (let row = 2; row <= 101; row++) {
    const datasetId = cell(row, "A");
    const rawTime = cell(row, "I");
    const actor: Person = {
      datasetId,
      name: cell(row, "C"),
      gender: cell(row, "E"),
      date: normalizeWorkbookDate(cell(row, "F")),
      city: cell(row, "G"),
      country: cell(row, "H"),
      time: rawTime === "DOT" ? rawTime : normalizeWorkbookTime(rawTime),
      timezone: cell(row, "J"),
      latitude: Number(cell(row, "K")),
      longitude: Number(cell(row, "L")),
      provenance: { sourceFile: "AB Dataset.xlsx", sourceSheet: "100 Actors", row },
    };
    if (actor.time === "DOT" && integerActorNumber(datasetId) <= 5) {
      const prior = await pool.query("SELECT subject_snapshot FROM eval_dataset_subjects WHERE subject_key=$1 ORDER BY created_at LIMIT 1", [datasetId]);
      const priorTime = prior.rows[0]?.subject_snapshot?.time;
      if (typeof priorTime !== "string") throw new Error(`${datasetId} has no stored benchmark birth time to reuse`);
      actor.time = normalizeWorkbookTime(priorTime);
      actor.provenance = { ...actor.provenance, birthTime: "reused from existing Judge benchmark subject snapshot" };
    }
    if (actor.time === "DOT") throw new Error(`${datasetId} actor birth time is missing`);
    const rawPartner = cell(row, "M");
    const partnerData = integerActorNumber(datasetId) > 5 && rawPartner ? JSON.parse(rawPartner) : null;
    const partnerTime = partnerData?.time === "DOT"
      ? assignedBenchmarkTime(`${datasetId}:${partnerData.datasetId}:partner-time`)
      : partnerData ? normalizeWorkbookTime(String(partnerData.time)) : null;
    const partner = partnerData ? {
      datasetId: String(partnerData.datasetId),
      name: String(partnerData.name),
      gender: String(partnerData.gender),
      date: String(partnerData.date),
      city: String(partnerData.city),
      country: String(partnerData.country),
      time: partnerTime!,
      timezone: String(partnerData.timezone),
      latitude: Number(partnerData.latitude),
      longitude: Number(partnerData.longitude),
      relation: String(partnerData.relation),
      provenance: partnerData?.time === "DOT"
        ? { ...(partnerData.birthDataProvenance ?? {}), time: { status: "benchmark_randomized_by_user_request", seed: `${datasetId}:${partnerData.datasetId}:partner-time` } }
        : partnerData.birthDataProvenance ?? { sourceFile: "AB Dataset.xlsx", sourceSheet: "100 Actors", row },
    } as Person : null;
    for (const [label, person] of [["actor", actor], ["partner", partner]] as const) {
      if (!person && integerActorNumber(datasetId) > 5) throw new Error(`${datasetId} has no ${label} data`);
      if (person && (!person.date || !person.city || !person.country || !person.time || !person.timezone || !Number.isFinite(person.latitude) || !Number.isFinite(person.longitude))) {
        throw new Error(`${datasetId} has incomplete ${label} data`);
      }
    }
    actors.push({ actor, partner });
  }
  if (actors.length !== 100 || actors.some(({ actor }, index) => integerActorNumber(actor.datasetId) !== index + 1)) {
    throw new Error("AB Dataset.xlsx must contain cb-actor-001 through cb-actor-100 in rows 2-101");
  }
  return actors;
}

async function cgJson(pathname: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const baseUrl = argument("--cg-base-url") ?? process.env.COSMIC_GUIDANCE_INTERNAL_BASE_URL;
  const secretRef = process.env.JUDGE_TO_CG_SHARED_SECRET_REF;
  if (!baseUrl || !secretRef) throw new Error("CG URL and Judge-to-CG secret reference are required");
  const secret = await resolveSecret(secretRef);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-judge-shared-secret": secret },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`CG ${pathname} failed (${response.status}): ${text}`);
  return JSON.parse(text) as Record<string, any>;
}

async function calcSnapshot(calcInputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await cgJson("/api/internal/judge/calc-snapshot", { calcInputs })).inputSnapshot;
}

async function prepareRequest(track: string, inputSnapshot: Record<string, unknown>, requestId: string) {
  const prepared = await cgJson("/api/internal/judge/prepare-batch-request", { track, inputSnapshot, requestId, model: MODEL, promptVersion: PROMPT_VERSION });
  if (prepared.endpoint !== "/v1/chat/completions" || prepared.requestBody?.model !== MODEL) {
    throw new Error(`CG prepared an invalid Batch request for ${requestId}`);
  }
  return prepared;
}

async function buildCases(actor: Person, partner: Person | null): Promise<{ cases: CaseDefinition[]; deterministic: Array<{ readingType: string; output: Record<string, unknown> }> }> {
  const actorNumber = integerActorNumber(actor.datasetId);
  const [actorNumbers, natal] = await Promise.all([
    calcSnapshot({ numerologyProfile: { birthDate: actor.date, fullName: actor.name, year: 2026 } }),
    calcSnapshot({ chartType: "natal", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country } }),
  ]);
  const actorProfile = actorNumbers.numerologyProfile as Record<string, number>;
  const staticProfile = await calcSnapshot({ staticProfile: { birthDate: actor.date, numerologyProfile: actorProfile } });
  const cases: CaseDefinition[] = [];
  const add = (track: string, readingType: string, readingSubtype: string, inputSnapshot: Record<string, unknown>, tags: string[]) => {
    cases.push({ caseKey: `${actor.datasetId}:${readingType}:${readingSubtype}`, track, readingType, readingSubtype, inputSnapshot, tags });
  };
  const numbers = [
    ["life_path", "lifePathNumber"], ["expression", "expressionNumber"], ["soul_urge", "soulUrgeNumber"],
    ["personality", "personalityNumber"], ["birthday_number", "birthdayNumber"], ["personal_year", "currentPersonalYear"],
  ] as const;
  for (const [numberType, field] of numbers) {
    for (const insightType of ["detailed", "brief"] as const) {
      add("numerology", `numerology_${numberType}`, insightType, { numberType, numberValue: actorProfile[field], insightType, ...(numberType === "personal_year" ? { year: 2026 } : {}) }, ["numerology", numberType, insightType]);
    }
  }
  add("zodiac_profile", "zodiac_profile", "full", { birthDate: actor.date, chartDetails: natal.chartDetails }, ["zodiac_profile"]);
  const name = fullNameParts(actor.name);
  add("universal_insights", "universal_insights", "full", {
    ...name, birthDate: actor.date, birthTime: actor.time, birthCity: actor.city, birthCountry: actor.country,
    natalChartDetails: natal.chartDetails, numerologyProfile: actorProfile,
  }, ["universal_insights"]);

  if (actorNumber > 5) {
    if (!partner) throw new Error(`${actor.datasetId} requires a compatibility partner`);
    const [partnerNumbers, transit, synastry, composite] = await Promise.all([
      calcSnapshot({ numerologyProfile: { birthDate: partner.date, fullName: partner.name, year: 2026 } }),
      calcSnapshot({ chartType: "transit", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country }, transitDate: TRANSIT_DATE, transitTime: "12:00" }),
      calcSnapshot({ chartType: "synastry", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country }, partnerName: partner.name, partnerDate: partner.date, partnerTime: partner.time, partnerLocation: { city: partner.city, nation: partner.country } }),
      calcSnapshot({ chartType: "composite", name: actor.name, date: actor.date, time: actor.time, location: { city: actor.city, nation: actor.country }, partnerName: partner.name, partnerDate: partner.date, partnerTime: partner.time, partnerLocation: { city: partner.city, nation: partner.country } }),
    ]);
    const partnerProfile = partnerNumbers.numerologyProfile as Record<string, number>;
    for (const insightType of ["detailed", "brief"] as const) {
      add("natal", "natal", insightType, { ...natal, insightType }, ["natal", insightType]);
      add("transit", "transit", insightType, { ...transit, transitDate: TRANSIT_DATE, insightType }, ["transit", insightType]);
      add("tarot", "tarot", insightType, { spreadType: "three-card", question: TAROT_QUESTION, cards: TAROT_CARDS, insightType }, ["tarot", "traditional_three_card", insightType]);
      add("synastry", "synastry", insightType, { ...synastry, readingType: "synastry", person1Name: actor.name, person2Name: partner.name, insightType }, ["compatibility", "synastry", partner.relation ?? "partner", insightType]);
      add("composite", "composite", insightType, { ...composite, readingType: "composite", person1Name: actor.name, person2Name: partner.name, insightType }, ["compatibility", "composite", partner.relation ?? "partner", insightType]);
      add("number_compatibility", "number_compatibility", insightType, { person1: { name: actor.name, lifePathNumber: actorProfile.lifePathNumber, expressionNumber: actorProfile.expressionNumber, soulUrgeNumber: actorProfile.soulUrgeNumber, personalityNumber: actorProfile.personalityNumber }, person2: { name: partner.name, lifePathNumber: partnerProfile.lifePathNumber, expressionNumber: partnerProfile.expressionNumber, soulUrgeNumber: partnerProfile.soulUrgeNumber, personalityNumber: partnerProfile.personalityNumber }, insightType }, ["compatibility", "number_compatibility", partner.relation ?? "partner", insightType]);
    }
  }
  return {
    cases,
    deterministic: [
      { readingType: "birth_chart", output: natal },
      { readingType: "cosmic_map", output: natal },
      { readingType: "cosmic_wheel", output: staticProfile },
    ],
  };
}

async function ensureCorpus(actors: Array<{ actor: Person; partner: Person | null }>) {
  const sourceChecksum = sha256({ actors, model: MODEL, transitDate: TRANSIT_DATE, tarotQuestion: TAROT_QUESTION, tarotCards: TAROT_CARDS, promptVersion: PROMPT_VERSION });
  const existing = await pool.query("SELECT id FROM eval_datasets WHERE track=$1 AND version=$2", [DATASET_TRACK, DATASET_VERSION]);
  if (existing.rowCount) {
    if (!RESUME) throw new Error(`Dataset ${DATASET_VERSION} already exists; use --resume`);
    const datasetId = existing.rows[0].id as string;
    const experiment = await pool.query("SELECT id FROM eval_experiments WHERE dataset_id=$1 AND comparison_type='batch_only' ORDER BY created_at DESC LIMIT 1", [datasetId]);
    const run = await pool.query("SELECT id FROM eval_generation_runs WHERE experiment_id=$1 AND provider_batch_id IS NULL ORDER BY created_at LIMIT 1", [experiment.rows[0]?.id]);
    if (!experiment.rowCount || !run.rowCount) throw new Error("Existing corpus is not resumable");
    return { datasetId, experimentId: experiment.rows[0].id as string, runId: run.rows[0].id as string };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dataset = await client.query("INSERT INTO eval_datasets (track,version,description,source_checksum,case_count,created_by) VALUES ($1,$2,$3,$4,0,$5) RETURNING id", [DATASET_TRACK, DATASET_VERSION, "CG production Batch-only corpus: actors 006-100 full set plus missing artifacts for 001-005", sourceChecksum, "cg-batch-corpus"]);
    const datasetId = dataset.rows[0].id as string;
    const subjectIds = new Set<string>();
    for (const { actor, partner } of actors) {
      for (const subject of [actor, partner].filter(Boolean) as Person[]) {
        if (subjectIds.has(subject.datasetId)) continue;
        subjectIds.add(subject.datasetId);
        await client.query("INSERT INTO eval_dataset_subjects (dataset_id,subject_key,source_reference_hash,subject_snapshot,subject_checksum,metadata) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)", [datasetId, subject.datasetId, sha256(subject.datasetId), JSON.stringify(subject), sha256(subject), JSON.stringify({ sourceFile: "AB Dataset.xlsx", sourceSheet: "100 Actors" })]);
      }
    }
    const config = await client.query("SELECT id FROM eval_config_versions WHERE config_key='global' ORDER BY version DESC LIMIT 1");
    if (!config.rowCount) throw new Error("No Judge global config exists");
    const experiment = await client.query("INSERT INTO eval_experiments (name,track,dataset_id,baseline_model,candidate_model,baseline_prompt_version,candidate_prompt_version,config_version_id,comparison_type,baseline_execution_mode,candidate_execution_mode,created_by,status) VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'batch_only','openai_batch','openai_batch',$7,'running') RETURNING id", ["CG production Batch-only corpus", DATASET_TRACK, datasetId, MODEL, PROMPT_VERSION, config.rows[0].id, "cg-batch-corpus"]);
    const experimentId = experiment.rows[0].id as string;
    const run = await client.query("INSERT INTO eval_generation_runs (experiment_id,arm,execution_mode,provider,model,endpoint,prompt_version,status,completion_window,total_requests,metadata) VALUES ($1,'candidate','openai_batch','openai',$2,'/v1/chat/completions',$3,'pending','24h',0,$4::jsonb) RETURNING id", [experimentId, MODEL, PROMPT_VERSION, JSON.stringify({ purpose: "local_batch_preparation", datasetVersion: DATASET_VERSION, submissionProhibitedUntilExplicitUserAction: true })]);
    await client.query("COMMIT");
    return { datasetId, experimentId, runId: run.rows[0].id as string };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function storeActor(corpus: { datasetId: string; experimentId: string; runId: string }, actor: Person, partner: Person | null) {
  const existing = await pool.query("SELECT count(*) FROM eval_dataset_cases WHERE dataset_id=$1 AND case_key LIKE $2", [corpus.datasetId, `${actor.datasetId}:%`]);
  if (Number(existing.rows[0].count) === 0) {
    const built = await buildCases(actor, partner);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const subject = await client.query("SELECT id FROM eval_dataset_subjects WHERE dataset_id=$1 AND subject_key=$2", [corpus.datasetId, actor.datasetId]);
      if (!subject.rowCount) throw new Error(`Missing subject row for ${actor.datasetId}`);
      for (const item of built.cases) {
        const checksum = sha256(item.inputSnapshot);
        const inserted = await client.query("INSERT INTO eval_dataset_cases (dataset_id,subject_id,case_key,track,input_snapshot,prompt_version,tags,reading_type,reading_subtype,input_checksum,schema_version,calculator_version,provenance) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,'cg-production-json','cg-astroverse-current',$11::jsonb) ON CONFLICT (dataset_id,case_key) DO NOTHING RETURNING id", [corpus.datasetId, subject.rows[0].id, item.caseKey, item.track, JSON.stringify(item.inputSnapshot), PROMPT_VERSION, JSON.stringify(item.tags), item.readingType, item.readingSubtype, checksum, JSON.stringify({ source: "CosmicGuidance production calculator and prompt builder", transitDate: TRANSIT_DATE })]);
        const existingCase = inserted.rowCount ? null : (await client.query("SELECT id,input_checksum FROM eval_dataset_cases WHERE dataset_id=$1 AND case_key=$2", [corpus.datasetId, item.caseKey])).rows[0];
        const caseId = inserted.rows[0]?.id ?? existingCase?.id;
        if (!caseId || existingCase?.input_checksum !== undefined && existingCase.input_checksum !== checksum) throw new Error(`Case conflict for ${item.caseKey}`);
        await client.query("INSERT INTO eval_jobs (experiment_id,case_id,idempotency_key,status) VALUES ($1,$2,$3,'pending') ON CONFLICT (idempotency_key) DO NOTHING", [corpus.experimentId, caseId, `${DATASET_VERSION}:${item.caseKey}`]);
      }
      for (const item of built.deterministic) {
        const normalizedOutput = normalizeCalculationArtifact(item.readingType, item.output);
        const caseKey = `${actor.datasetId}:${item.readingType}:calculation`;
        const checksum = sha256({ actorId: actor.datasetId, readingType: item.readingType });
        const inserted = await client.query("INSERT INTO eval_dataset_cases (dataset_id,subject_id,case_key,track,input_snapshot,prompt_version,tags,reading_type,reading_subtype,input_checksum,schema_version,calculator_version,provenance) VALUES ($1,$2,$3,'deterministic',$4::jsonb,$5,$6::jsonb,$7,'calculation',$8,'cg-calculation','cg-astroverse-current',$9::jsonb) ON CONFLICT (dataset_id,case_key) DO NOTHING RETURNING id", [corpus.datasetId, subject.rows[0].id, caseKey, JSON.stringify({ actorId: actor.datasetId, readingType: item.readingType }), PROMPT_VERSION, JSON.stringify(["calculation_only", item.readingType]), item.readingType, checksum, JSON.stringify({ source: "CosmicGuidance production calculator" })]);
        const existingCase = inserted.rowCount ? null : (await client.query("SELECT id,input_checksum FROM eval_dataset_cases WHERE dataset_id=$1 AND case_key=$2", [corpus.datasetId, caseKey])).rows[0];
        const caseId = inserted.rows[0]?.id ?? existingCase?.id;
        if (!caseId || existingCase?.input_checksum !== undefined && existingCase.input_checksum !== checksum) throw new Error(`Calculation case conflict for ${caseKey}`);
        const outputChecksum = sha256(canonicalJson(normalizedOutput));
        const artifact = await client.query("INSERT INTO eval_deterministic_artifacts (case_id,artifact_type,output_snapshot,output_checksum,provenance) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb) ON CONFLICT (case_id,artifact_type) DO NOTHING RETURNING id", [caseId, item.readingType, JSON.stringify(normalizedOutput), outputChecksum, JSON.stringify({ source: "CosmicGuidance production calculator", generatedFor: actor.datasetId })]);
        if (!artifact.rowCount) {
          const existingArtifact = await client.query("SELECT output_snapshot FROM eval_deterministic_artifacts WHERE case_id=$1 AND artifact_type=$2", [caseId, item.readingType]);
          if (!existingArtifact.rowCount || sha256(canonicalJson(normalizeCalculationArtifact(item.readingType, existingArtifact.rows[0].output_snapshot))) !== outputChecksum) throw new Error(`Calculation artifact conflict for ${caseKey}`);
          await client.query("UPDATE eval_deterministic_artifacts SET output_snapshot=$1::jsonb,output_checksum=$2 WHERE case_id=$3 AND artifact_type=$4", [JSON.stringify(normalizedOutput), outputChecksum, caseId, item.readingType]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const pending = await pool.query("SELECT c.id,c.case_key,c.track,c.input_snapshot FROM eval_dataset_cases c LEFT JOIN eval_prepared_requests p ON p.case_id=c.id WHERE c.dataset_id=$1 AND c.case_key LIKE $2 AND c.track <> 'deterministic' AND p.id IS NULL ORDER BY c.case_key", [corpus.datasetId, `${actor.datasetId}:%`]);
  for (const row of pending.rows) {
    const prepared = await prepareRequest(row.track, row.input_snapshot as Record<string, unknown>, row.case_key as string);
    const body = prepared.requestBody as Record<string, unknown>;
    const bodyChecksum = sha256(body);
    const customId = `${DATASET_VERSION}:${row.case_key}:${bodyChecksum.slice(0, 16)}`;
    const promptVersion = typeof prepared.promptVersion === "string" ? prepared.promptVersion : PROMPT_VERSION;
    await pool.query("UPDATE eval_dataset_cases SET prompt_version=$1 WHERE id=$2", [promptVersion, row.id]);
    const inserted = await pool.query("INSERT INTO eval_prepared_requests (execution_run_id,case_id,provider,model,endpoint,prompt_version,custom_id,request_body,request_body_checksum,system_prompt_tokens,user_prompt_tokens,assistant_context_tokens,prompt_character_count,system_prompt_hash,user_prompt_hash) VALUES ($1,$2,'openai',$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (execution_run_id,case_id) DO NOTHING RETURNING id", [corpus.runId, row.id, MODEL, prepared.endpoint, promptVersion, customId, JSON.stringify(body), bodyChecksum, prepared.systemPromptTokens, prepared.userPromptTokens, prepared.assistantContextTokens, prepared.promptCharacterCount, prepared.systemPromptHash, prepared.userPromptHash]);
    if (!inserted.rowCount) {
      const existing = await pool.query("SELECT request_body_checksum,custom_id FROM eval_prepared_requests WHERE execution_run_id=$1 AND case_id=$2", [corpus.runId, row.id]);
      if (!existing.rowCount || existing.rows[0].request_body_checksum !== bodyChecksum || existing.rows[0].custom_id !== customId) {
        throw new Error(`Prepared request conflict for ${row.case_key}`);
      }
    }
  }
}

function partitionLines(rows: PreparedRow[]) {
  const partitions: Array<{ rows: PreparedRow[]; contents: string }> = [];
  let current: PreparedRow[] = [];
  let size = 0;
  for (const row of rows) {
    const line = `${JSON.stringify({ custom_id: row.custom_id, method: "POST", url: "/v1/chat/completions", body: row.request_body })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_BATCH_BYTES) throw new Error(`Request ${row.case_key} exceeds the OpenAI Batch file limit`);
    if (current.length && (size + bytes > MAX_BATCH_BYTES || current.length === MAX_BATCH_LINES)) {
      partitions.push({ rows: current, contents: current.map((item) => `${JSON.stringify({ custom_id: item.custom_id, method: "POST", url: "/v1/chat/completions", body: item.request_body })}\n`).join("") });
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length) partitions.push({ rows: current, contents: current.map((item) => `${JSON.stringify({ custom_id: item.custom_id, method: "POST", url: "/v1/chat/completions", body: item.request_body })}\n`).join("") });
  return partitions;
}

async function writePartitions(corpus: { datasetId: string; experimentId: string; runId: string }) {
  const expectedAi = 95 * 26 + 5 * 14;
  const expectedDeterministic = 100 * 3;
  const prepared = await pool.query("SELECT count(*) FROM eval_prepared_requests p JOIN eval_generation_runs r ON r.id=p.execution_run_id WHERE r.experiment_id=$1", [corpus.experimentId]);
  const deterministic = await pool.query("SELECT count(*) FROM eval_deterministic_artifacts a JOIN eval_dataset_cases c ON c.id=a.case_id WHERE c.dataset_id=$1", [corpus.datasetId]);
  if (Number(prepared.rows[0].count) !== expectedAi || Number(deterministic.rows[0].count) !== expectedDeterministic) throw new Error(`Corpus is incomplete: prepared=${prepared.rows[0].count}/${expectedAi}, deterministic=${deterministic.rows[0].count}/${expectedDeterministic}`);
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  const manifest: Array<Record<string, unknown>> = [];
  const customIds = new Set<string>();
  for (let partition = 1; partition <= 10; partition++) {
    const firstActor = (partition - 1) * 10 + 1;
    const lower = `cb-actor-${String(firstActor).padStart(3, "0")}:`;
    const upper = `cb-actor-${String(firstActor + 10).padStart(3, "0")}:`;
    const rows = (await pool.query("SELECT p.id,c.case_key,p.custom_id,p.request_body,p.request_body_checksum FROM eval_prepared_requests p JOIN eval_dataset_cases c ON c.id=p.case_id JOIN eval_generation_runs r ON r.id=p.execution_run_id WHERE r.experiment_id=$1 AND c.case_key >= $2 AND c.case_key < $3 ORDER BY c.case_key", [corpus.experimentId, lower, upper])).rows as PreparedRow[];
    const expected = partition === 1 ? 5 * 14 + 5 * 26 : 10 * 26;
    if (rows.length !== expected) throw new Error(`Partition ${partition} has ${rows.length}/${expected} requests`);
    const contents = rows.map((row) => {
      const body = row.request_body as Record<string, unknown>;
      const validMessages = Array.isArray(body.messages) && body.messages.length > 0 && body.messages.every((message) => {
        const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
        return typeof content === "string" && content.trim().length > 0;
      });
      if (customIds.has(row.custom_id) || body.model !== MODEL || !validMessages) {
        throw new Error(`Invalid or duplicate request for ${row.case_key}`);
      }
      customIds.add(row.custom_id);
      return `${JSON.stringify({ custom_id: row.custom_id, method: "POST", url: "/v1/chat/completions", body })}\n`;
    }).join("");
    const byteCount = Buffer.byteLength(contents);
    if (byteCount > MAX_BATCH_BYTES) throw new Error(`Partition ${partition} exceeds the Batch file limit`);
    for (const line of contents.trimEnd().split("\n")) {
      const parsed = JSON.parse(line);
      if (parsed.method !== "POST" || parsed.url !== "/v1/chat/completions" || parsed.body?.model !== MODEL || !parsed.custom_id) throw new Error("Generated invalid Batch JSONL line");
    }
    const filePath = path.join(ARTIFACT_DIRECTORY, `${DATASET_VERSION}.part-${String(partition).padStart(2, "0")}.jsonl`);
    await writeFile(filePath, contents, "utf8");
    const runId = partition === 1 ? corpus.runId : (await pool.query("INSERT INTO eval_generation_runs (experiment_id,arm,execution_mode,provider,model,endpoint,prompt_version,status,completion_window,total_requests,metadata) VALUES ($1,'candidate','openai_batch','openai',$2,'/v1/chat/completions',$3,'pending','24h',$4,$5::jsonb) RETURNING id", [corpus.experimentId, MODEL, PROMPT_VERSION, rows.length, JSON.stringify({ purpose: "local_batch_preparation", datasetVersion: DATASET_VERSION, partition, submissionProhibitedUntilExplicitUserAction: true })])).rows[0].id as string;
    if (partition > 1) await pool.query("UPDATE eval_prepared_requests SET execution_run_id=$1 WHERE id = ANY($2::uuid[])", [runId, rows.map((row) => row.id)]);
    const checksum = sha256(contents);
    await pool.query("UPDATE eval_generation_runs SET total_requests=$1,metadata=COALESCE(metadata,'{}'::jsonb) || $2::jsonb,updated_at=NOW() WHERE id=$3", [rows.length, JSON.stringify({ partition, inputFilePath: filePath, localJsonlSha256: checksum, localJsonlBytes: byteCount }), runId]);
    manifest.push({ partition, runId, filePath, requestCount: rows.length, byteCount, sha256: checksum, firstCaseKey: rows[0].case_key, lastCaseKey: rows.at(-1)!.case_key });
  }
  if (customIds.size !== expectedAi) throw new Error("Batch request count mismatch");
  await pool.query("UPDATE eval_datasets SET case_count=$1 WHERE id=$2", [expectedAi + expectedDeterministic, corpus.datasetId]);
  const manifestPath = path.join(ARTIFACT_DIRECTORY, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ datasetId: corpus.datasetId, experimentId: corpus.experimentId, datasetVersion: DATASET_VERSION, model: MODEL, transitDate: TRANSIT_DATE, tarot: { question: TAROT_QUESTION, spreadType: "three-card", cards: TAROT_CARDS }, aiRequests: expectedAi, calculationOnlyArtifacts: expectedDeterministic, partitions: manifest }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ datasetId: corpus.datasetId, experimentId: corpus.experimentId, aiRequests: expectedAi, calculationOnlyArtifacts: expectedDeterministic, manifestPath, partitions: manifest }, null, 2));
}

async function main() {
  const actors = await loadActors();
  const corpus = await ensureCorpus(actors);
  // The production chart calculator depends on an external ephemeris service.
  // Serialize preparation so its availability does not compromise corpus integrity.
  const concurrency = 2;
  for (let start = 0; start < actors.length; start += concurrency) {
    const group = actors.slice(start, start + concurrency);
    await Promise.all(group.map(async (item) => {
      try {
        await storeActor(corpus, item.actor, item.partner);
      } catch (error) {
        throw new Error(`${item.actor.datasetId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    for (const [offset, item] of group.entries()) {
      console.log(`Prepared ${start + offset + 1}/100: ${item.actor.datasetId}`);
    }
  }
  await writePartitions(corpus);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => pool.end());
