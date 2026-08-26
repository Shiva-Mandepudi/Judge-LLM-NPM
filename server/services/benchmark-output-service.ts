import { pool } from "../db.js";

type Row = Record<string, any>;

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

function summary(row: Row) {
  return {
    generationId: row.id,
    executionMode: row.execution_mode,
    provider: row.provider,
    model: row.model,
    schemaValid: row.schema_valid,
    error: row.error,
    usage: usage(row),
  };
}

function detail(row: Row) {
  const providerMetadata = metadata(row.provider_metadata);
  return {
    ...summary(row),
    endpoint: row.endpoint,
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

async function experiment(experimentId: string): Promise<Row> {
  const result = await pool.query(
    `SELECT e.id, e.name, e.dataset_id, e.reference_run_id, e.baseline_execution_mode,
            e.candidate_execution_mode, e.status, d.track, d.version AS dataset_version
       FROM eval_experiments e
       JOIN eval_datasets d ON d.id = e.dataset_id
      WHERE e.id = $1`,
    [experimentId],
  );
  if (!result.rowCount) throw new Error("Experiment not found");
  return result.rows[0] as Row;
}

async function candidateRows(experimentId: string) {
  const result = await pool.query(
    `SELECT g.*
       FROM eval_generations g
       JOIN eval_jobs j ON j.id = g.job_id
      WHERE j.experiment_id = $1
      ORDER BY g.created_at`,
    [experimentId],
  );
  return result.rows as Row[];
}

export async function listBenchmarkCases(experimentId: string) {
  const [selectedExperiment, jobsResult, candidates] = await Promise.all([
    experiment(experimentId),
    pool.query(
      `SELECT j.id AS job_id, j.status AS job_status, j.last_error AS job_error,
              c.id AS case_id, c.case_key, c.reading_type, c.reading_subtype, c.tags,
              s.subject_key,
              rg.*
         FROM eval_jobs j
         JOIN eval_dataset_cases c ON c.id = j.case_id
         LEFT JOIN eval_dataset_subjects s ON s.id = c.subject_id
         LEFT JOIN eval_reference_generations rg
           ON rg.reference_run_id = (SELECT reference_run_id FROM eval_experiments WHERE id = $1)
          AND rg.case_id = c.id
        WHERE j.experiment_id = $1
        ORDER BY s.subject_key, c.case_key`,
      [experimentId],
    ),
    candidateRows(experimentId),
  ]);
  const candidatesByJob = new Map<string, Row[]>();
  for (const candidate of candidates) {
    const values = candidatesByJob.get(candidate.job_id) ?? [];
    values.push(candidate);
    candidatesByJob.set(candidate.job_id, values);
  }
  return {
    experiment: {
      id: selectedExperiment.id,
      name: selectedExperiment.name,
      datasetId: selectedExperiment.dataset_id,
      datasetVersion: selectedExperiment.dataset_version,
      track: selectedExperiment.track,
      baselineExecutionMode: selectedExperiment.baseline_execution_mode,
      candidateExecutionMode: selectedExperiment.candidate_execution_mode,
      status: selectedExperiment.status,
    },
    cases: jobsResult.rows.map((row: Row) => ({
      caseId: row.case_id,
      caseKey: row.case_key,
      readingType: row.reading_type,
      readingSubtype: row.reading_subtype,
      tags: row.tags ?? [],
      subjectKey: row.subject_key,
      job: { id: row.job_id, status: row.job_status, error: row.job_error },
      standard: row.id ? summary(row) : null,
      candidates: (candidatesByJob.get(row.job_id) ?? []).map(summary),
    })),
  };
}

export async function getBenchmarkCase(experimentId: string, caseId: string) {
  const selectedExperiment = await experiment(experimentId);
  const jobResult = await pool.query(
    `SELECT j.id AS job_id, j.status AS job_status, j.last_error AS job_error,
            c.id AS case_id, c.case_key, c.reading_type, c.reading_subtype, c.tags,
            c.input_snapshot, c.input_checksum, s.subject_key, s.subject_snapshot
       FROM eval_jobs j
       JOIN eval_dataset_cases c ON c.id = j.case_id
       LEFT JOIN eval_dataset_subjects s ON s.id = c.subject_id
      WHERE j.experiment_id = $1 AND c.id = $2`,
    [experimentId, caseId],
  );
  if (!jobResult.rowCount) throw new Error("Benchmark case not found in this experiment");
  const job = jobResult.rows[0] as Row;
  const [standardResult, candidateResult] = await Promise.all([
    selectedExperiment.reference_run_id
      ? pool.query(
        "SELECT * FROM eval_reference_generations WHERE reference_run_id = $1 AND case_id = $2",
        [selectedExperiment.reference_run_id, caseId],
      )
      : Promise.resolve({ rows: [] as Row[] }),
    pool.query("SELECT * FROM eval_generations WHERE job_id = $1 ORDER BY created_at", [job.job_id]),
  ]);
  return {
    experiment: {
      id: selectedExperiment.id,
      name: selectedExperiment.name,
      datasetVersion: selectedExperiment.dataset_version,
      track: selectedExperiment.track,
    },
    subject: { key: job.subject_key, snapshot: job.subject_snapshot },
    case: {
      id: job.case_id,
      key: job.case_key,
      readingType: job.reading_type,
      readingSubtype: job.reading_subtype,
      tags: job.tags ?? [],
      inputSnapshot: job.input_snapshot,
      inputChecksum: job.input_checksum,
      job: { id: job.job_id, status: job.job_status, error: job.job_error },
    },
    standard: standardResult.rows[0] ? detail(standardResult.rows[0] as Row) : null,
    candidates: (candidateResult.rows as Row[]).map(detail),
  };
}
