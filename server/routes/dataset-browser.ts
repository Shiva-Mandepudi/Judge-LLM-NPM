import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";

type Row = Record<string, any>;

const listQuerySchema = z.object({
  datasetId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(200).optional(),
});

function metadata(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function usage(row: Row) {
  return {
    promptTokens: row.tokens_prompt,
    completionTokens: row.tokens_completion,
    cachedTokens: row.tokens_cached,
    reasoningTokens: row.tokens_reasoning,
    totalTokens: row.tokens_total,
    systemPromptTokens: row.system_prompt_tokens,
    userPromptTokens: row.user_prompt_tokens,
    assistantContextTokens: row.assistant_context_tokens,
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd,
  };
}

function generationDetail(row: Row) {
  const providerMetadata = metadata(row.provider_metadata);
  return {
    generationId: row.id,
    referenceRunId: row.reference_run_id,
    executionMode: row.execution_mode,
    provider: row.provider,
    model: row.model,
    schemaValid: row.schema_valid,
    error: row.error,
    usage: usage(row),
    requestId: row.request_id,
    providerRequestId: row.provider_request_id,
    providerBatchId: row.provider_batch_id,
    requestBody: providerMetadata.requestBody ?? null,
    parsedOutput: row.parsed_output,
    rawOutput: row.raw_output,
    responseHash: row.response_hash,
    responseCharacterCount: row.response_character_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export const datasetBrowserRouter = Router();

// Paginated, searchable subject list for one dataset. Only light per-subject
// fields are returned; snapshots and cases load on demand per subject.
datasetBrowserRouter.get("/subjects", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", details: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const { datasetId, page, pageSize, search } = parsed.data;
  const params: unknown[] = [datasetId];
  let searchClause = "";
  if (search) {
    params.push(`%${search}%`);
    searchClause = `AND (s.subject_key ILIKE $2 OR s.subject_snapshot->>'name' ILIKE $2)`;
  }
  params.push(pageSize, (page - 1) * pageSize);
  const limitParam = params.length - 1;
  const offsetParam = params.length;
  const result = await pool.query(
    `SELECT s.id, s.subject_key, s.subject_snapshot, COUNT(*) OVER() AS total,
            COALESCE(c.case_count, 0) AS case_count,
            COALESCE(a.artifact_count, 0) AS artifact_count
       FROM eval_dataset_subjects s
       LEFT JOIN (
         SELECT subject_id, COUNT(*) AS case_count
           FROM eval_dataset_cases GROUP BY subject_id
       ) c ON c.subject_id = s.id
       LEFT JOIN (
         SELECT dc.subject_id, COUNT(*) AS artifact_count
           FROM eval_deterministic_artifacts da
           JOIN eval_dataset_cases dc ON dc.id = da.case_id
          GROUP BY dc.subject_id
       ) a ON a.subject_id = s.id
      WHERE s.dataset_id = $1
        AND s.subject_key NOT LIKE 'partner-%'
        AND s.subject_key NOT LIKE 'relative-%'
        AND s.subject_key NOT LIKE 'supplied-partner-%'
        AND s.subject_key NOT LIKE 'web-partner-%' ${searchClause}
      ORDER BY s.subject_key
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );
  const rows = result.rows as Row[];
  res.json({
    subjects: rows.map((row) => {
      const snapshot = metadata(row.subject_snapshot);
      return {
        id: row.id,
        subjectKey: row.subject_key,
        name: snapshot.name ?? null,
        gender: snapshot.gender ?? null,
        date: snapshot.date ?? null,
        city: snapshot.city ?? null,
        country: snapshot.country ?? null,
        caseCount: Number(row.case_count),
        artifactCount: Number(row.artifact_count),
      };
    }),
    total: rows.length ? Number(rows[0].total) : 0,
    page,
    pageSize,
  });
});

// One subject's full snapshot plus its light case list (no generation payloads).
datasetBrowserRouter.get("/subjects/:subjectId", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.subjectId).success) {
    res.status(400).json({ error: "invalid_subject_id" });
    return;
  }
  const subjectResult = await pool.query(
    `SELECT s.id, s.dataset_id, s.subject_key, s.subject_snapshot, s.subject_checksum, s.metadata, d.track, d.version AS dataset_version
       FROM eval_dataset_subjects s
       JOIN eval_datasets d ON d.id = s.dataset_id
      WHERE s.id = $1`,
    [req.params.subjectId],
  );
  if (!subjectResult.rowCount) {
    res.status(404).json({ error: "subject_not_found" });
    return;
  }
  const subject = subjectResult.rows[0] as Row;
  const [casesResult, partnerResult] = await Promise.all([
    pool.query(
      `SELECT c.id, c.case_key, c.reading_type, c.reading_subtype, c.tags, c.prompt_version,
              (c.gold_output IS NOT NULL) AS has_gold
         FROM eval_dataset_cases c
        WHERE c.subject_id = $1
        ORDER BY c.reading_type, c.reading_subtype, c.case_key`,
      [req.params.subjectId],
    ),
    pool.query(
      `SELECT subject_key, subject_snapshot
         FROM eval_dataset_subjects
        WHERE dataset_id = $1
          AND (subject_key LIKE 'partner-%' OR subject_key LIKE 'relative-%'
               OR subject_key LIKE 'supplied-partner-%' OR subject_key LIKE 'web-partner-%')`,
      [subject.dataset_id],
    ),
  ]);
  // Auxiliary subjects (partners/relatives, no cases of their own) belong to
  // one owning actor — resolved from the actor key embedded in their subject
  // key, or from the "100 Actors" sheet row in their snapshot provenance
  // (sheet row N = actor N-1, since actors occupy rows 2–101).
  const relatedPeople = (partnerResult.rows as Row[])
    .filter((row) => {
      const keyMatch = row.subject_key.match(/cb-actor-\d{3}/);
      if (keyMatch) return keyMatch[0] === subject.subject_key;
      const sheetRow = metadata(row.subject_snapshot).provenance?.row;
      return typeof sheetRow === "number" && `cb-actor-${String(sheetRow - 1).padStart(3, "0")}` === subject.subject_key;
    })
    .map((row) => ({ subjectKey: row.subject_key, snapshot: row.subject_snapshot }));
  res.json({
    subject: {
      id: subject.id,
      subjectKey: subject.subject_key,
      snapshot: subject.subject_snapshot,
      checksum: subject.subject_checksum,
      metadata: subject.metadata,
      datasetTrack: subject.track,
      datasetVersion: subject.dataset_version,
    },
    cases: (casesResult.rows as Row[]).map((row) => ({
      caseId: row.id,
      caseKey: row.case_key,
      readingType: row.reading_type,
      readingSubtype: row.reading_subtype,
      tags: row.tags ?? [],
      promptVersion: row.prompt_version,
      hasGold: row.has_gold,
    })),
    relatedPeople,
  });
});

// Full case evidence: input snapshot, gold output, frozen CG reference
// generations, and the deterministic calculation artifacts for the case.
datasetBrowserRouter.get("/cases/:caseId", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.caseId).success) {
    res.status(400).json({ error: "invalid_case_id" });
    return;
  }
  const caseResult = await pool.query(
    `SELECT c.id, c.case_key, c.reading_type, c.reading_subtype, c.tags, c.prompt_version,
            c.input_snapshot, c.input_checksum, c.schema_version, c.calculator_version,
            c.gold_output, c.provenance, s.subject_key
       FROM eval_dataset_cases c
       LEFT JOIN eval_dataset_subjects s ON s.id = c.subject_id
      WHERE c.id = $1`,
    [req.params.caseId],
  );
  if (!caseResult.rowCount) {
    res.status(404).json({ error: "case_not_found" });
    return;
  }
  const row = caseResult.rows[0] as Row;
  const [referencesResult, outputsResult, artifactsResult] = await Promise.all([
    pool.query(
      "SELECT * FROM eval_reference_generations WHERE case_id = $1 ORDER BY created_at",
      [req.params.caseId],
    ),
    pool.query(
      `SELECT g.*, e.id AS experiment_id, e.name AS experiment_name
         FROM eval_generations g
         JOIN eval_jobs j ON j.id = g.job_id
         JOIN eval_experiments e ON e.id = j.experiment_id
        WHERE j.case_id = $1
        ORDER BY e.created_at, g.created_at`,
      [req.params.caseId],
    ),
    pool.query(
      "SELECT artifact_type, output_snapshot, output_checksum, provenance FROM eval_deterministic_artifacts WHERE case_id = $1 ORDER BY artifact_type",
      [req.params.caseId],
    ),
  ]);
  res.json({
    case: {
      id: row.id,
      key: row.case_key,
      readingType: row.reading_type,
      readingSubtype: row.reading_subtype,
      tags: row.tags ?? [],
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
      calculatorVersion: row.calculator_version,
      inputSnapshot: row.input_snapshot,
      inputChecksum: row.input_checksum,
      provenance: row.provenance,
      subjectKey: row.subject_key,
    },
    goldOutput: row.gold_output ?? null,
    references: (referencesResult.rows as Row[]).map(generationDetail),
    outputs: (outputsResult.rows as Row[]).map((generation) => ({
      ...generationDetail(generation),
      experiment: { id: generation.experiment_id, name: generation.experiment_name },
    })),
    artifacts: (artifactsResult.rows as Row[]).map((artifact) => ({
      artifactType: artifact.artifact_type,
      outputSnapshot: artifact.output_snapshot,
      outputChecksum: artifact.output_checksum,
      provenance: artifact.provenance,
    })),
  });
});
