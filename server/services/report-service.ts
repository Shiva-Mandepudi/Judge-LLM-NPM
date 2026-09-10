import type { Arm } from "./blind-ab-service.js";
import { armForLabel } from "./blind-ab-service.js";
import { evalJudgeScores } from "../../shared/schema.js";

type DimensionScoreMap = Record<string, { score: number; justification: string }>;
type HardGateMap = Record<string, { pass: boolean; violationDetail: string | null }>;

/** Decode blind A/B labels for the human-facing comparison-run report. */
export function decodeJudgeScore(
  row: typeof evalJudgeScores.$inferSelect,
  blindLabelMap: { A: Arm; B: Arm },
) {
  const dimensionScores = row.dimensionScores as Record<string, DimensionScoreMap>;
  const hardGateResults = row.hardGateResults as Record<string, HardGateMap>;
  function byArm<T>(labeled: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [label, value] of Object.entries(labeled)) {
      const arm = label === "Tie" ? "Tie" : armForLabel(blindLabelMap, label as "A" | "B");
      out[arm] = value;
    }
    return out;
  }

  const winnerLabel = row.pairwiseWinner as "A" | "B" | "Tie" | null;
  const winnerArm = winnerLabel === null ? null : winnerLabel === "Tie" ? "Tie" : armForLabel(blindLabelMap, winnerLabel);

  return {
    judgeRole: row.judgeRole,
    provider: row.provider,
    model: row.model,
    rubricVersion: row.rubricVersion,
    dimensionScoresByArm: byArm(dimensionScores),
    hardGateResultsByArm: byArm(hardGateResults),
    winnerArm,
    rationale: row.rationale,
    confidenceLevel: row.confidenceLevel,
    latencyMs: row.latencyMs,
  };
}
