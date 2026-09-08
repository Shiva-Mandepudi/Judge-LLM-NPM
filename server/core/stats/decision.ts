import type { BootstrapInterval } from "../contracts/evaluation.js";
import type { ModelStatistics } from "./bootstrap.js";

export type TrackDecision = { recommendation: string | "NO RECOMMENDATION"; step: "gate" | "degeneracy" | "quality" | "cost" | "withheld"; reasons: string[]; eligible: string[] };

export function decideTrack(stats: Record<string, ModelStatistics>, compositeDelta: Record<string, BootstrapInterval>, costs: Record<string, number | null>, options: { maxFailureRateUpperBound: number; maxDegenerateRate: number; qualityMarginDelta: number; noiseBand?: number }): TrackDecision {
  const reasons: string[] = []; const flagged = new Set<string>();
  for (const [model, modelStats] of Object.entries(stats)) {
    if (Object.entries(modelStats.gateFailureRate).some(([, gate]) => gate.wilsonUpper > options.maxFailureRateUpperBound)) { flagged.add(model); reasons.push(`${model}: hard-gate Wilson upper bound exceeds threshold`); continue; }
    if ((modelStats.degenerateRate ?? 0) > options.maxDegenerateRate) { flagged.add(model); reasons.push(`${model}: degenerate rate exceeds threshold`); }
  }
  const unflagged = Object.keys(stats).filter((model) => !flagged.has(model));
  if (!unflagged.length) return { recommendation: "NO RECOMMENDATION", step: "gate", reasons, eligible: [] };
  const leader = [...unflagged].sort((a, b) => (stats[b].composite.estimate ?? -Infinity) - (stats[a].composite.estimate ?? -Infinity))[0]; // core-vocab-ok: composite is a generic weighted statistic.
  const eligible = unflagged.filter((model) => (stats[model].composite.upper ?? -Infinity) >= (stats[leader].composite.estimate ?? Infinity) - options.qualityMarginDelta); // core-vocab-ok: composite is a generic weighted statistic.
  if (!eligible.length) return { recommendation: "NO RECOMMENDATION", step: "quality", reasons: [...reasons, "no model is quality-eligible"] , eligible: [] };
  if (options.noiseBand !== undefined && eligible.every((model) => model === leader || Math.abs(compositeDelta[model]?.estimate ?? 0) <= options.noiseBand!)) reasons.push("quality is within the judge noise band; cost is the only separator");
  const recommendation = [...eligible].sort((a, b) => (costs[a] ?? Infinity) - (costs[b] ?? Infinity))[0];
  return { recommendation, step: "cost", reasons, eligible };
}
