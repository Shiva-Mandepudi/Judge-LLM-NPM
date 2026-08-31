import "dotenv/config";
import { pool } from "../server/db.js";

const experimentId = process.argv[2];
const runId = process.argv[3];
if (!experimentId) throw new Error("Usage: tsx scripts/reset-zero-request-batch-failures.ts <experiment-id>");

const result = await pool.query(
  `UPDATE eval_generation_runs
      SET status='pending', provider_batch_id=NULL, input_file_id=NULL, output_file_id=NULL, error_file_id=NULL,
          total_requests=(SELECT count(*) FROM eval_prepared_requests p WHERE p.execution_run_id=eval_generation_runs.id),
          submitted_at=NULL, in_progress_at=NULL, finalizing_at=NULL, completed_at=NULL, failed_at=NULL, expires_at=NULL,
          metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('previousFailedBatch', metadata->'openaiBatch'), updated_at=NOW()
    WHERE experiment_id=$1 AND status IN ('failed','pending') AND completed_requests=0 AND failed_requests=0
      AND ($2::uuid IS NULL OR id=$2::uuid)
    RETURNING id`,
  [experimentId, runId ?? null],
);
console.log(JSON.stringify({ resetRunIds: result.rows.map((row) => row.id) }, null, 2));
await pool.end();
