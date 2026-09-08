import type { BootstrapInterval, ScoreRow } from "../contracts/evaluation.js";

const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const quantile = (values: number[], p: number) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * p; const lower = Math.floor(position); const upper = Math.ceil(position); return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower); };
const intervalFromSamples = (observed: number[], samples: number[]): BootstrapInterval => { const finite = samples.filter(Number.isFinite); return { estimate: mean(observed), lower: quantile(finite, 0.025), upper: quantile(finite, 0.975), n: observed.length }; };
const seeded = (seed: number) => { let value = seed >>> 0; return () => { value = (1664525 * value + 1013904223) >>> 0; return value / 0x100000000; }; };

export function bootstrapMean(values: readonly number[], iterations = 1000, seed = 1): BootstrapInterval {
  if (!values.length) return { estimate: null, lower: null, upper: null, n: 0 };
  const random = seeded(seed); const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
    estimates.push(mean(sample)!);
  }
  return { estimate: mean(values), lower: quantile(estimates, 0.025), upper: quantile(estimates, 0.975), n: values.length };
}

export type ModelStatistics = { metrics: Record<string, BootstrapInterval>; composite: BootstrapInterval; abstentionRate: Record<string, number>; gateFailureRate: Record<string, { failures: number; total: number; rate: number; wilsonUpper: number }>; degenerateRate: number }; // core-vocab-ok: composite is the plan's universal weighted quality statistic.
export type BootstrapResult = { byModel: Record<string, ModelStatistics>; deltas: Record<string, Record<string, BootstrapInterval>>; users: number; iterations: number; seed: number };

function wilsonUpper(failures: number, total: number, z = 1.96): number {
  if (!total) return 1;
  const p = failures / total; const denominator = 1 + z * z / total; const centre = p + z * z / (2 * total); const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return Math.min(1, (centre + spread) / denominator);
}

export function pairedClusterBootstrap(rows: readonly ScoreRow[], champion: string, weights: Record<string, number>, iterations = 1000, seed = 1): BootstrapResult {
  const users = [...new Set(rows.map((row) => row.userId))]; const models = [...new Set(rows.map((row) => row.modelRef))]; const random = seeded(seed);
  const metricKeys = [...new Set(rows.flatMap((row) => Object.keys(row.metrics)))];
  const compositeFor = (row: ScoreRow) => { const values = Object.entries(weights).map(([key, weight]) => ({ value: row.metrics[key], weight })).filter((item): item is { value: number; weight: number } => typeof item.value === "number"); return values.length === Object.keys(weights).length ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / values.reduce((sum, item) => sum + item.weight, 0) : null; };
  const estimate = (sampledUsers: string[]) => {
    const selected = sampledUsers.flatMap((userId) => rows.filter((row) => row.userId === userId));
    const values: Record<string, Record<string, number[]>> = {}; const composites: Record<string, number[]> = {};
    for (const model of models) { values[model] = {}; composites[model] = []; }
    for (const row of selected) {
      if (!values[row.modelRef]) continue;
      for (const key of metricKeys) if (typeof row.metrics[key] === "number") (values[row.modelRef][key] ??= []).push(row.metrics[key]!);
      const composite = compositeFor(row); if (composite !== null) composites[row.modelRef].push(composite); // core-vocab-ok: composite is a generic weighted statistic.
    }
    return { values, composites };
  };
  const metricSamples: Record<string, Record<string, number[]>> = Object.fromEntries(models.map((model) => [model, Object.fromEntries(metricKeys.map((key) => [key, []]))]));
  const compositeSamples: Record<string, number[]> = Object.fromEntries(models.map((model) => [model, []]));
  const deltaSamples: Record<string, Record<string, number[]>> = Object.fromEntries(models.filter((model) => model !== champion).map((model) => [model, Object.fromEntries([...metricKeys, "composite"].map((key) => [key, []]))])); // core-vocab-ok: composite is a generic weighted statistic.
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sampledUsers = Array.from({ length: users.length }, () => users[Math.floor(random() * users.length)]); const result = estimate(sampledUsers);
    for (const model of models) { for (const key of metricKeys) metricSamples[model][key].push(mean(result.values[model][key] ?? []) ?? NaN); compositeSamples[model].push(mean(result.composites[model]) ?? NaN); }
    for (const model of Object.keys(deltaSamples)) { for (const key of metricKeys) deltaSamples[model][key].push((mean(result.values[model][key] ?? []) ?? NaN) - (mean(result.values[champion][key] ?? []) ?? NaN)); deltaSamples[model].composite.push((mean(result.composites[model]) ?? NaN) - (mean(result.composites[champion]) ?? NaN)); } // core-vocab-ok: composite is a generic weighted statistic.
  }
  const byModel: Record<string, ModelStatistics> = {};
  for (const model of models) {
    const modelRows = rows.filter((row) => row.modelRef === model); const metrics: Record<string, BootstrapInterval> = {};
    for (const key of metricKeys) { const observed = modelRows.map((row) => row.metrics[key]).filter((value): value is number => typeof value === "number"); metrics[key] = intervalFromSamples(observed, metricSamples[model][key]); }
    const observedComposite = modelRows.map(compositeFor).filter((value): value is number => value !== null); const abstentionRate = Object.fromEntries(metricKeys.map((key) => [key, modelRows.length ? modelRows.filter((row) => row.metrics[key] === null).length / modelRows.length : 0]));
    const gateFailureRate = Object.fromEntries([...new Set(modelRows.flatMap((row) => Object.keys(row.gates)))].map((key) => { const observed = modelRows.map((row) => row.gates[key]).filter((value): value is boolean => typeof value === "boolean"); const failures = observed.filter((value) => !value).length; return [key, { failures, total: observed.length, rate: observed.length ? failures / observed.length : 0, wilsonUpper: wilsonUpper(failures, observed.length) }]; }));
    byModel[model] = { metrics, composite: intervalFromSamples(observedComposite, compositeSamples[model]), abstentionRate, gateFailureRate, degenerateRate: modelRows.length ? modelRows.filter((row) => row.degenerate === true).length / modelRows.length : 0 }; // core-vocab-ok: composite is a generic weighted statistic.
  }
  const deltas: BootstrapResult["deltas"] = Object.fromEntries(Object.entries(deltaSamples).map(([model, values]) => [model, Object.fromEntries(Object.entries(values).map(([key, sample]) => [key, { estimate: mean(sample.filter(Number.isFinite)), lower: quantile(sample.filter(Number.isFinite), 0.025), upper: quantile(sample.filter(Number.isFinite), 0.975), n: sample.filter(Number.isFinite).length }]))]));
  return { byModel, deltas, users: users.length, iterations, seed };
}

export function compositeQuality(metrics: Record<string, number | null>, weights: Record<string, number>): number | null {
  const entries = Object.entries(weights).map(([key, weight]) => ({ value: metrics[key], weight })).filter((item): item is { value: number; weight: number } => typeof item.value === "number");
  return entries.length === Object.keys(weights).length ? entries.reduce((sum, item) => sum + item.value * item.weight, 0) / entries.reduce((sum, item) => sum + item.weight, 0) : null;
}

export function wilsonInterval(failures: number, total: number): { lower: number; upper: number } { const upper = wilsonUpper(failures, total); const z = 1.96; const p = total ? failures / total : 0; const denominator = total ? 1 + z * z / total : 1; const centre = total ? p + z * z / (2 * total) : 0; const spread = total ? z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) : 0; return { lower: Math.max(0, (centre - spread) / denominator), upper }; }
