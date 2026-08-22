import type { Db } from "../db.js";
import { evalAuditLog } from "../../shared/schema.js";

export interface AuditEventInput {
  eventName: string;
  actor: string;
  experimentId?: string;
  jobId?: string;
  datasetId?: string;
  configVersionId?: string;
  promptVersion?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

// Full audit history: every experiment/job/dataset/config action is recorded
// with the exact prompt version, model, and config version in effect, so any
// historical decision can be reconstructed. Judge-owned, never touches
// Cosmic Guidance's audit log/Elasticsearch sink.
export async function logAudit(db: Db, input: AuditEventInput): Promise<void> {
  await db.insert(evalAuditLog).values({
    eventName: input.eventName,
    actor: input.actor,
    experimentId: input.experimentId,
    jobId: input.jobId,
    datasetId: input.datasetId,
    configVersionId: input.configVersionId,
    promptVersion: input.promptVersion,
    model: input.model,
    metadata: input.metadata ?? {},
  });
}
