import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalHumanReviewQueue } from "../../shared/schema.js";
import { logAudit } from "./audit-service.js";

export async function enqueueHumanReview(
  db: Db,
  params: { jobId: string; experimentId: string; reason: "hard_gate_failure" | "judge_disagreement" | "borderline" | "low_confidence" },
): Promise<void> {
  await db.insert(evalHumanReviewQueue).values({ jobId: params.jobId, experimentId: params.experimentId, reason: params.reason });
}

export async function listPendingReviews(db: Db) {
  return db.select().from(evalHumanReviewQueue).where(eq(evalHumanReviewQueue.status, "pending"));
}

export async function resolveReview(
  db: Db,
  params: { reviewId: string; resolvedBy: string; decision: "confirm_fail" | "overturn_pass" | "needs_more_data"; notes?: string },
): Promise<void> {
  await db
    .update(evalHumanReviewQueue)
    .set({ status: "resolved", resolutionDecision: params.decision, resolutionNotes: params.notes, resolvedAt: new Date(), assignedTo: params.resolvedBy })
    .where(eq(evalHumanReviewQueue.id, params.reviewId));

  await logAudit(db, { eventName: "human_review.resolved", actor: params.resolvedBy, jobId: undefined, metadata: { reviewId: params.reviewId, decision: params.decision } });
}
