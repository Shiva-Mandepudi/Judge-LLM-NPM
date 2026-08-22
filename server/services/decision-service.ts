import type { ExperimentStats } from "./stats-service.js";
import type { AcceptanceThresholds, JudgeConfig } from "../../shared/config-schema.js";

export type Recommendation = "pass" | "hold" | "rollback";

export interface DecisionResult {
  recommendation: Recommendation;
  reasons: string[];
  nonInferiorityPass: boolean;
  requiresHumanReview: boolean;
}

/**
 * Statistical recommendation only — this service NEVER mutates production
 * model configuration. It is read by a human operator (via the admin
 * dashboard/API) who decides whether and how to act on it.
 *
 * Decision rule:
 * - "rollback": any hard-gate failure occurred (zero tolerance, per config).
 *   For a not-yet-launched candidate this means "do not launch"; for a
 *   candidate already in canary/production it means "revert to baseline" —
 *   either way the actionable instruction is the same: candidate must not run.
 * - "hold": thresholds are borderline, or primary/secondary judge agreement
 *   is below the configured floor — ambiguous signal, needs human review.
 * - "pass": every threshold clears with margin and no hard failures.
 */
export function decide(
  stats: ExperimentStats,
  thresholds: AcceptanceThresholds,
  humanReviewTriggers: JudgeConfig["humanReviewTriggers"],
  minSampleSize?: number,
): DecisionResult {
  const reasons: string[] = [];
  let requiresHumanReview = false;

  if (stats.hardGateFailureCount > 0) {
    reasons.push(`${stats.hardGateFailureCount} hard-gate failure(s) — zero tolerance per acceptance rules.`);
    if (humanReviewTriggers.onHardGateFailure) requiresHumanReview = true;
    return { recommendation: "rollback", reasons, nonInferiorityPass: false, requiresHumanReview };
  }

  // Framework §6.1: a launch-gate sample below the required minimum can't
  // support a trustworthy pass/rollback claim — the decision is statistically
  // premature, not a real non-inferiority result, regardless of what the
  // point estimate currently shows.
  if (minSampleSize !== undefined && stats.sampleSize < minSampleSize) {
    reasons.push(`Sample size ${stats.sampleSize} is below the required launch-gate minimum of ${minSampleSize} — result is not yet statistically trustworthy.`);
    return { recommendation: "hold", reasons, nonInferiorityPass: false, requiresHumanReview: false };
  }

  const softDegradations = Object.entries(stats.dimensionDeltas).filter(([, delta]) => delta < -thresholds.maxSoftDimensionDegradation);
  if (softDegradations.length > 0) {
    reasons.push(`Soft-dimension degradation exceeds ${thresholds.maxSoftDimensionDegradation}: ${softDegradations.map(([d, v]) => `${d}=${v.toFixed(2)}`).join(", ")}`);
  }

  const winPlusTie = stats.winRate + stats.tieRate;
  if (winPlusTie < thresholds.minWinPlusTieRate) {
    reasons.push(`Win+tie rate ${(winPlusTie * 100).toFixed(1)}% is below the required ${(thresholds.minWinPlusTieRate * 100).toFixed(0)}%.`);
  }

  if (stats.judgeAgreementRate !== null && stats.judgeAgreementRate < thresholds.minJudgeAgreementRate) {
    reasons.push(`Primary/secondary judge agreement ${(stats.judgeAgreementRate * 100).toFixed(1)}% is below the required ${(thresholds.minJudgeAgreementRate * 100).toFixed(0)}%.`);
    if (humanReviewTriggers.onJudgeDisagreement) requiresHumanReview = true;
  }

  const nonInferiorityPass = softDegradations.length === 0 && winPlusTie >= thresholds.minWinPlusTieRate;

  const borderline =
    Math.abs(winPlusTie - thresholds.minWinPlusTieRate) <= humanReviewTriggers.borderlineBandWidth ||
    softDegradations.some(([, delta]) => Math.abs(-delta - thresholds.maxSoftDimensionDegradation) <= humanReviewTriggers.borderlineBandWidth);
  if (borderline && humanReviewTriggers.onBorderlineNonInferiority) requiresHumanReview = true;

  if (!nonInferiorityPass || borderline) {
    return { recommendation: "hold", reasons: reasons.length ? reasons : ["Borderline result — within the human-review band of the threshold."], nonInferiorityPass, requiresHumanReview };
  }

  return { recommendation: "pass", reasons: ["All acceptance thresholds cleared."], nonInferiorityPass: true, requiresHumanReview };
}
