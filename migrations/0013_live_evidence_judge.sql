-- Connect comparison runs to the documented evidence-based judge pipeline.
-- Existing phase artifacts remain readable; new live runs use these fields.

ALTER TABLE eval_judgements_v2 ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES eval_jobs(id);
ALTER TABLE eval_judgements_v2 ADD COLUMN IF NOT EXISTS judge_role text;
ALTER TABLE eval_judgements_v2 ADD COLUMN IF NOT EXISTS judge_provider text;
UPDATE eval_judgements_v2 SET judge_role = COALESCE(judge_role, 'primary') WHERE judge_role IS NULL;
UPDATE eval_judgements_v2 SET judge_provider = COALESCE(judge_provider, 'unknown') WHERE judge_provider IS NULL;
ALTER TABLE eval_judgements_v2 ALTER COLUMN judge_role SET NOT NULL;
ALTER TABLE eval_judgements_v2 ALTER COLUMN judge_provider SET NOT NULL;
CREATE INDEX IF NOT EXISTS eval_judgements_v2_job_idx ON eval_judgements_v2 (job_id, judge_role, model_ref);

ALTER TABLE eval_run_manifests ADD COLUMN IF NOT EXISTS report_snapshot jsonb;
ALTER TABLE eval_run_manifests ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
