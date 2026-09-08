import type { ScoreRow } from "../contracts/evaluation.js";

export type MetricDistribution = {
  n: number;
  counts: Record<string, number>;
  mean: number | null;
  standardDeviation: number | null;
  entropy: number | null;
  dominantShare: number;
  nondiscriminating: boolean;
};

const numericScores = (rows: readonly ScoreRow[], metric: string) => rows.map((row) => row.metrics[metric]).filter((value): value is number => typeof value === "number");

export function metricDistribution(rows: readonly ScoreRow[], metric: string): MetricDistribution {
  const values = numericScores(rows, metric);
  const counts = Object.fromEntries([...new Set(values)].sort((a, b) => a - b).map((value) => [String(value), values.filter((candidate) => candidate === value).length]));
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const variance = average === null ? null : values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  const entropy = values.length ? -Object.values(counts).reduce((sum, count) => { const probability = count / values.length; return sum + probability * Math.log2(probability); }, 0) : null;
  const dominantShare = values.length ? Math.max(...Object.values(counts)) / values.length : 0;
  return { n: values.length, counts, mean: average, standardDeviation: variance === null ? null : Math.sqrt(variance), entropy, dominantShare, nondiscriminating: dominantShare > 0.8 };
}

export function pearsonCorrelation(left: readonly number[], right: readonly number[]): number | null {
  const n = Math.min(left.length, right.length);
  if (n < 2) return null;
  const leftMean = left.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const rightMean = right.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const numerator = left.slice(0, n).reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftScale = Math.sqrt(left.slice(0, n).reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightScale = Math.sqrt(right.slice(0, n).reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftScale && rightScale ? numerator / (leftScale * rightScale) : null;
}

export function intraclassCorrelation(rows: readonly ScoreRow[], metric: string): number | null {
  const grouped = new Map<string, number[]>();
  for (const row of rows) { const value = row.metrics[metric]; if (typeof value === "number") (grouped.get(row.userId) ?? grouped.set(row.userId, []).get(row.userId)!).push(value); }
  const groups = [...grouped.values()].filter((values) => values.length > 0);
  const total = groups.reduce((sum, values) => sum + values.length, 0);
  if (groups.length < 2 || total <= groups.length) return null;
  const grandMean = groups.flat().reduce((sum, value) => sum + value, 0) / total;
  const between = groups.reduce((sum, values) => sum + values.length * ((values.reduce((a, b) => a + b, 0) / values.length) - grandMean) ** 2, 0) / (groups.length - 1);
  const within = groups.reduce((sum, values) => { const average = values.reduce((a, b) => a + b, 0) / values.length; return sum + values.reduce((inner, value) => inner + (value - average) ** 2, 0); }, 0) / (total - groups.length);
  return Math.max(-1, Math.min(1, (between - within) / (between + (groups.reduce((sum, values) => sum + values.length, 0) / groups.length - 1) * within)));
}

export function designEffect(rowsPerCluster: number, icc: number): number { return 1 + Math.max(0, rowsPerCluster - 1) * Math.max(0, icc); }
export function effectiveSampleSize(rowCount: number, rowsPerCluster: number, icc: number): number { return rowCount / designEffect(rowsPerCluster, icc); }
export function requiredUsers(pairedStandardDeviation: number, detectableDelta: number, alpha = 0.05, power = 0.8): number {
  if (pairedStandardDeviation <= 0 || detectableDelta <= 0) return 0;
  const zAlpha = alpha <= 0.05 ? 1.96 : 1.645;
  const zPower = power >= 0.8 ? 0.84 : 0.52;
  return Math.ceil(((zAlpha + zPower) * pairedStandardDeviation / detectableDelta) ** 2);
}

export function audit5Register(actual: { distinctKeys: number; gateKeys: number; assignments: number; gateAssignments: number }): { ok: boolean; expected: typeof actual; actual: typeof actual } {
  const expected = { distinctKeys: 31, gateKeys: 9, assignments: 37, gateAssignments: 11 };
  return { ok: JSON.stringify(actual) === JSON.stringify(expected), expected, actual };
}
