import type { ScoreRow } from "../contracts/evaluation.js";
import { agreementWithinOne, gateAgreement } from "./calibration.js";

export type JudgeComparison = { metricAgreement: ReturnType<typeof agreementWithinOne>; gateAgreement: number; noiseBand: number | null };
const standardDeviation = (values: readonly number[]) => {
  if (!values.length) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
};

export function compareJudgeRows(primary: ScoreRow, secondary: ScoreRow): JudgeComparison {
  const left = primary.metrics;
  const right = secondary.metrics;
  const differences = Object.keys(left).map((key) => [left[key], right[key]] as const).filter((pair): pair is [number, number] => typeof pair[0] === "number" && typeof pair[1] === "number").map(([a, b]) => b - a);
  return { metricAgreement: agreementWithinOne(left, right), gateAgreement: gateAgreement(primary.gates, secondary.gates), noiseBand: standardDeviation(differences) };
}

export type ContaminationVerdict = { verdict: "reference-free-safe" | "reference-sensitive" | "insufficient-data"; compared: number; meanAbsoluteDelta: number | null };
export function contaminationVerdict(referenceFree: readonly ScoreRow[], withReference: readonly ScoreRow[], threshold = 0.25): ContaminationVerdict {
  const keyed = new Map(referenceFree.map((row) => [`${row.userId}|${row.modelRef}`, row]));
  const deltas: number[] = [];
  for (const row of withReference) {
    const baseline = keyed.get(`${row.userId}|${row.modelRef}`);
    if (!baseline) continue;
    const left = Object.values(baseline.metrics).filter((value): value is number => typeof value === "number");
    const right = Object.values(row.metrics).filter((value): value is number => typeof value === "number");
    if (left.length && right.length) deltas.push(Math.abs(right.reduce((a, b) => a + b, 0) / right.length - left.reduce((a, b) => a + b, 0) / left.length));
  }
  if (!deltas.length) return { verdict: "insufficient-data", compared: 0, meanAbsoluteDelta: null };
  const meanAbsoluteDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return { verdict: meanAbsoluteDelta > threshold ? "reference-sensitive" : "reference-free-safe", compared: deltas.length, meanAbsoluteDelta };
}
