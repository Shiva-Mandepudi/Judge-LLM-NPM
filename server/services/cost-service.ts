import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import {
  evalComparisonRuns,
  evalDatasetCases,
  evalDatasetSubjects,
  evalGenerations,
  evalJobs,
  evalJudgeScores,
  evalJudgementsV2,
  evalLlmRequestAttempts,
} from "../../shared/schema.js";
import { costForUsage, percentile } from "../core/cost/cost.js";
import { getActiveConfig, getConfigVersion } from "../config/config-service.js";
import {
  createDrizzlePricingStore,
  getLatestValidSnapshot,
  getSnapshot,
  type PricingRateRecord,
  type PricingSnapshotRecord,
  type PricingStore,
} from "./pricing-service.js";
import { resolveRunCaseSelection } from "./run-case-selection.js";

// The single authoritative cost aggregation service. The browser never computes
// totals — every rollup, rate, and variance below is resolved server-side.
// Money rules (spec §4.4, §11): provider-reported cost wins; otherwise price
// persisted usage against the run's immutable snapshot; missing usage or a
// missing rate yields `unknown` with a reason — a null money value is never
// coerced to 0. Sums use Number and final monetary outputs are rounded to 6
// decimal places at the response boundary only.

export type CostStatus = "known" | "partial" | "unknown";
export interface CostComponent {
  costUsd: number | null;
  status: CostStatus;
}

export const MISSING_USAGE_REASON = "missing token usage";

export function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

const roundMoneyOrNull = (value: number | null): number | null => (value === null ? null : roundMoney(value));

// ---------------------------------------------------------------------------
// Rate lookup — keyed (provider, modelId, usageMode). Batch pricing applies
// only when the row's endpoint/metadata indicates a batch call. A missing
// rate is an unknown cost; standard pricing is never substituted for batch.
// ---------------------------------------------------------------------------

const rateKey = (provider: string, modelId: string, usageMode: string) => `${provider}|${modelId}|${usageMode}`;

export function buildRateMap(rates: readonly PricingRateRecord[]): Map<string, PricingRateRecord> {
  const map = new Map<string, PricingRateRecord>();
  for (const rate of rates) map.set(rateKey(rate.provider, rate.modelId, rate.usageMode || "standard"), rate);
  return map;
}

export interface CostRowLike {
  provider: string;
  model: string;
  endpoint?: string | null;
  providerBatchId?: string | null;
  providerMetadata?: unknown;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  tokensCached: number | null;
  tokensCacheWrite?: number | null;
  costUsd: number | null;
}

function indicatesBatch(row: Pick<CostRowLike, "endpoint" | "providerBatchId" | "providerMetadata">): boolean {
  if (row.providerBatchId) return true;
  if (row.endpoint && /batch/i.test(row.endpoint)) return true;
  const metadata = (row.providerMetadata ?? null) as Record<string, unknown> | null;
  return metadata?.usageMode === "batch" || metadata?.batch === true;
}

export function resolveRate(rateMap: Map<string, PricingRateRecord>, row: Pick<CostRowLike, "provider" | "model" | "endpoint" | "providerBatchId" | "providerMetadata">): PricingRateRecord | null {
  if (indicatesBatch(row)) {
    return rateMap.get(rateKey(row.provider, row.model, "batch")) ?? null;
  }
  return rateMap.get(rateKey(row.provider, row.model, "standard")) ?? null;
}

// Cache-read and cache-write tokens are persisted separately. Metadata remains
// accepted for rows written before the dedicated column was added.
function cacheWriteTokens(row: Pick<CostRowLike, "providerMetadata" | "tokensCacheWrite">): number {
  if (row.tokensCacheWrite != null) return Math.max(0, row.tokensCacheWrite);
  const metadata = (row.providerMetadata ?? null) as Record<string, unknown> | null;
  const value = metadata?.cacheWriteInputTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface ResolvedRowCost {
  costUsd: number | null;
  status: CostStatus;
  source: "provider" | "snapshot" | "none";
  reason: string | null;
}

// Cost source precedence per spec §4.4: (1) trusted provider-reported cost,
// (2) persisted usage × snapshot rate across input/cache-read/cache-write/
// output categories, (3) unknown with a reason. A category whose rate is null
// while the usage exists contributes "unknown" — the row degrades to partial
// instead of silently undercounting.
export function resolveRowCost(row: CostRowLike, rateMap: Map<string, PricingRateRecord>): ResolvedRowCost {
  if (row.costUsd != null) return { costUsd: row.costUsd, status: "known", source: "provider", reason: null };
  if (row.tokensPrompt == null || row.tokensCompletion == null) {
    return { costUsd: null, status: "unknown", source: "none", reason: MISSING_USAGE_REASON };
  }
  const rate = resolveRate(rateMap, row);
  if (!rate) {
    return { costUsd: null, status: "unknown", source: "none", reason: `no pricing rate for ${row.provider}/${row.model}` };
  }
  const cacheRead = row.tokensCached != null && row.tokensCached > 0 ? row.tokensCached : 0;
  const cacheWrite = cacheWriteTokens(row);
  const categories = [
    { name: "input", tokens: Math.max(0, row.tokensPrompt - cacheRead - cacheWrite), rate: rate.inputUsdPerMillion },
    { name: "cacheRead", tokens: cacheRead, rate: rate.cacheReadUsdPerMillion },
    { name: "cacheWrite", tokens: cacheWrite, rate: rate.cacheWriteUsdPerMillion },
    { name: "output", tokens: row.tokensCompletion, rate: rate.outputUsdPerMillion },
  ];
  const used = categories.filter((category) => category.tokens > 0);
  const unpriced = used.filter((category) => category.rate == null);
  if (used.length > 0 && unpriced.length === used.length) {
    return { costUsd: null, status: "unknown", source: "none", reason: `pricing rate for ${row.provider}/${row.model} is missing ${unpriced.map((category) => category.name).join(", ")} rate` };
  }
  if (unpriced.length > 0) return { costUsd: null, status: "unknown", source: "none", reason: `pricing rate for ${row.provider}/${row.model} is missing ${unpriced.map((category) => category.name).join(", ")} rate` };
  const cost = costForUsage(
    { inputTokens: row.tokensPrompt, outputTokens: row.tokensCompletion, cacheReadInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite },
    {
      input: rate.inputUsdPerMillion ?? 0,
      output: rate.outputUsdPerMillion ?? 0,
      cacheRead: rate.cacheReadUsdPerMillion ?? 0,
      cacheWrite: rate.cacheWriteUsdPerMillion ?? 0,
    },
  );
  return { costUsd: cost, status: "known", source: "snapshot", reason: null };
}

// ---------------------------------------------------------------------------
// Retry dedupe — one provider call is counted once. Rows carry the worker's
// attempt number; legacy rows with attempt NULL predate attempt tracking and
// are treated as the final attempt. Keep only the max attempt per logical row.
// ---------------------------------------------------------------------------

const attemptRank = (attempt: number | null): number => (attempt == null ? Number.POSITIVE_INFINITY : attempt);

export function dedupeGenerations<T extends { jobId: string; arm: string; attempt: number | null }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.jobId}|${row.arm}`;
    const existing = best.get(key);
    if (!existing || attemptRank(row.attempt) >= attemptRank(existing.attempt)) best.set(key, row);
  }
  return [...best.values()];
}

export function dedupeJudgeScores<T extends { jobId: string; judgeRole: string; attempt: number | null }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.jobId}|${row.judgeRole}`;
    const existing = best.get(key);
    if (!existing || attemptRank(row.attempt) >= attemptRank(existing.attempt)) best.set(key, row);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface PricedRow {
  jobId: string;
  role: "candidate" | "primary" | "secondary";
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  cost: ResolvedRowCost;
}

export function summarizeRowCosts(rows: readonly ResolvedRowCost[]): CostComponent {
  const priced = rows.filter((row) => row.status !== "unknown");
  if (rows.length === 0 || priced.length === 0) return { costUsd: null, status: "unknown" };
  const sum = priced.reduce((total, row) => total + (row.costUsd ?? 0), 0);
  if (rows.every((row) => row.status === "known")) return { costUsd: roundMoney(sum), status: "known" };
  return { costUsd: roundMoney(sum), status: "partial" };
}

export interface RunJobContext {
  job: { id: string; status: string; caseId: string };
  readingType: string;
  readingSubtype: string | null;
  subjectKey: string | null;
}

type GenerationRow = typeof evalGenerations.$inferSelect;
type JudgeScoreRow = typeof evalJudgeScores.$inferSelect;
type LlmRequestAttemptRow = typeof evalLlmRequestAttempts.$inferSelect;
type RunRow = typeof evalComparisonRuns.$inferSelect;

export interface RunCostAnalysisInput {
  run: RunRow;
  jobs: RunJobContext[];
  generations: GenerationRow[];
  judgeScores: JudgeScoreRow[];
  requestAttempts?: LlmRequestAttemptRow[];
  pricing: { snapshot: PricingSnapshotRecord; rates: PricingRateRecord[] } | null;
}

export interface ReadingRollup {
  readingType: string;
  depth: string | null;
  model: string | null;
  cases: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  medianCostUsd: number | null;
  p95CostUsd: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  status: CostStatus;
}

export interface UserRollup {
  userKey: string;
  cases: number;
  candidateCostUsd: number | null;
  judgeCostUsd: number | null;
  totalKnownCostUsd: number | null;
  missingUsageCount: number;
  status: CostStatus;
}

export interface ModelRollup {
  provider: string;
  model: string;
  roles: string[];
  rows: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  status: CostStatus;
}

export interface StoredRunEstimate {
  cases: number;
  estimate: { candidate: CostComponent; primaryJudge: CostComponent; secondaryJudge: CostComponent; total: CostComponent };
  tokens: { inputTokens: number; outputTokens: number };
  assumptions: string[];
  pricedWith: { snapshotId: string | null };
}

export interface EstimateVsActual {
  estimate: StoredRunEstimate["estimate"];
  actual: CostComponent;
  absoluteVarianceUsd: number | null;
  percentageVariance: number | null;
  cases: { estimated: number; actual: number };
  tokens: {
    estimated: { inputTokens: number; outputTokens: number } | null;
    actual: { inputTokens: number; outputTokens: number };
    difference: { inputTokens: number; outputTokens: number } | null;
  };
  assumptions: string[];
}

export interface RunCostAnalysis {
  runId: string;
  currency: string;
  status: CostStatus;
  pricing: {
    snapshotId: string | null;
    source: "official";
    fetchedAt: Date | null;
  };
  summary: { candidate: CostComponent; primaryJudge: CostComponent; secondaryJudge: CostComponent; total: CostComponent };
  byReading: ReadingRollup[];
  byUser: UserRollup[];
  byModel: ModelRollup[];
  tokens: { input: { median: number | null; p95: number | null }; output: { median: number | null; p95: number | null } };
  latencyMs: { median: number | null; p95: number | null };
  missingUsageRate: number | null;
  unknownCostRate: number | null;
  warnings: string[];
  provenance: {
    baselineRowsExcluded: number;
    retryRowsExcluded: number;
    rowsWithProviderCost: number;
    rowsPricedFromSnapshot: number;
    rowsUnknown: number;
  };
  requestTelemetry: {
    attempts: number;
    succeeded: number;
    failed: number;
    started: number;
    retryAttempts: number;
    missingUsage: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
  };
  estimateVsActual: EstimateVsActual | null;
}

const sumOrNull = (rows: readonly PricedRow[]): number | null => {
  const priced = rows.filter((row) => row.cost.status !== "unknown");
  if (priced.length === 0) return null;
  return roundMoney(priced.reduce((total, row) => total + (row.cost.costUsd ?? 0), 0));
};

export function analyzeRunCost(input: RunCostAnalysisInput): RunCostAnalysis {
  const { run } = input;
  const requestAttempts = input.requestAttempts ?? [];
  const warnings: string[] = [];
  const rateMap = buildRateMap(input.pricing?.rates ?? []);

  if (run.pricingSnapshotId && !input.pricing) {
    warnings.push(`recorded pricing snapshot ${run.pricingSnapshotId} is no longer available; rate-based costs are unknown`);
  } else if (!input.pricing) {
    warnings.push("no valid pricing snapshot available; costs without provider-reported values are unknown");
  }

  // Baseline-arm rows are preserved dataset readings — reused content that is
  // never charged (spec §2), so they are excluded from every cost rollup.
  const candidateRowsAll = input.generations.filter((row) => row.arm === "candidate");
  const baselineRowsExcluded = input.generations.length - candidateRowsAll.length;
  const candidateGenerations = dedupeGenerations(candidateRowsAll);
  const judgeScores = dedupeJudgeScores(input.judgeScores);
  const retryRowsExcluded = candidateRowsAll.length - candidateGenerations.length + (input.judgeScores.length - judgeScores.length);

  const rows: PricedRow[] = [
    ...candidateGenerations.map((row) => ({
      jobId: row.jobId,
      role: "candidate" as const,
      provider: row.provider,
      model: row.model,
      inputTokens: row.tokensPrompt,
      outputTokens: row.tokensCompletion,
      tokensCacheWrite: row.tokensCacheWrite,
      latencyMs: row.latencyMs,
      cost: resolveRowCost(row, rateMap),
    })),
    ...judgeScores.map((row) => ({
      jobId: row.jobId,
      role: (row.judgeRole === "secondary" ? "secondary" : "primary") as "primary" | "secondary",
      provider: row.provider,
      model: row.model,
      inputTokens: row.tokensPrompt,
      outputTokens: row.tokensCompletion,
      tokensCacheWrite: row.tokensCacheWrite,
      latencyMs: row.latencyMs,
      cost: resolveRowCost(row, rateMap),
    })),
  ];

  const finishedJobs = input.jobs.filter(({ job }) => job.status === "completed" || job.status === "failed");
  if (finishedJobs.length === 0) {
    warnings.push("run has no finished jobs; no usage has been observed");
  } else if (run.status === "failed" || run.status === "cancelled") {
    warnings.push(`run is ${run.status}; costs reflect observed usage from ${finishedJobs.length} finished job(s) only`);
  }

  const summary = {
    candidate: summarizeRowCosts(rows.filter((row) => row.role === "candidate").map((row) => row.cost)),
    primaryJudge: summarizeRowCosts(rows.filter((row) => row.role === "primary").map((row) => row.cost)),
    secondaryJudge: summarizeRowCosts(rows.filter((row) => row.role === "secondary").map((row) => row.cost)),
    total: summarizeRowCosts(rows.map((row) => row.cost)),
  };
  const status: CostStatus = finishedJobs.length === 0 ? "unknown" : summary.total.status;

  // Per-job totals drive the per-reading median/p95 cost distribution.
  const jobTotals = new Map<string, { sum: number; hasPriced: boolean }>();
  for (const row of rows) {
    const entry = jobTotals.get(row.jobId) ?? { sum: 0, hasPriced: false };
    if (row.cost.status !== "unknown") {
      entry.sum += row.cost.costUsd ?? 0;
      entry.hasPriced = true;
    }
    jobTotals.set(row.jobId, entry);
  }

  const readingGroups = new Map<string, RunJobContext[]>();
  for (const context of input.jobs) {
    const key = `${context.readingType}|${context.readingSubtype ?? ""}`;
    if (!readingGroups.has(key)) readingGroups.set(key, []);
    readingGroups.get(key)!.push(context);
  }
  const byReading: ReadingRollup[] = [...readingGroups.entries()].map(([key, contexts]) => {
    const jobIds = new Set(contexts.map((context) => context.job.id));
    const groupRows = rows.filter((row) => jobIds.has(row.jobId));
    const caseCosts = contexts
      .map((context) => jobTotals.get(context.job.id))
      .filter((total): total is { sum: number; hasPriced: boolean } => Boolean(total?.hasPriced))
      .map((total) => total.sum);
    const models = groupRows.filter((row) => row.role === "candidate").map((row) => row.model);
    const model = models.length
      ? [...new Set(models)].map((candidate) => ({ candidate, count: models.filter((value) => value === candidate).length })).sort((a, b) => b.count - a.count)[0].candidate
      : null;
    const latencies = groupRows.map((row) => row.latencyMs).filter((value): value is number => value != null);
    const [readingType, depth] = key.split("|");
    return {
      readingType,
      depth: depth || null,
      model,
      cases: contexts.length,
      inputTokens: groupRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: groupRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      costUsd: sumOrNull(groupRows),
      medianCostUsd: roundMoneyOrNull(percentile(caseCosts, 0.5)),
      p95CostUsd: roundMoneyOrNull(percentile(caseCosts, 0.95)),
      medianLatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      status: summarizeRowCosts(groupRows.map((row) => row.cost)).status,
    };
  });

  const userGroups = new Map<string, RunJobContext[]>();
  for (const context of input.jobs) {
    const key = context.subjectKey ?? "unknown";
    if (!userGroups.has(key)) userGroups.set(key, []);
    userGroups.get(key)!.push(context);
  }
  const byUser: UserRollup[] = [...userGroups.entries()].map(([userKey, contexts]) => {
    const jobIds = new Set(contexts.map((context) => context.job.id));
    const groupRows = rows.filter((row) => jobIds.has(row.jobId));
    const candidate = sumOrNull(groupRows.filter((row) => row.role === "candidate"));
    const judge = sumOrNull(groupRows.filter((row) => row.role !== "candidate"));
    return {
      userKey,
      cases: contexts.length,
      candidateCostUsd: candidate,
      judgeCostUsd: judge,
      totalKnownCostUsd: sumOrNull(groupRows),
      missingUsageCount: groupRows.filter((row) => row.cost.reason === MISSING_USAGE_REASON).length,
      status: summarizeRowCosts(groupRows.map((row) => row.cost)).status,
    };
  });

  const modelGroups = new Map<string, PricedRow[]>();
  for (const row of rows) {
    const key = `${row.provider}|${row.model}`;
    if (!modelGroups.has(key)) modelGroups.set(key, []);
    modelGroups.get(key)!.push(row);
  }
  const byModel: ModelRollup[] = [...modelGroups.entries()].map(([key, groupRows]) => {
    const [provider, model] = key.split("|");
    return {
      provider,
      model,
      roles: [...new Set(groupRows.map((row) => row.role))].sort(),
      rows: groupRows.length,
      inputTokens: groupRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: groupRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      costUsd: sumOrNull(groupRows),
      status: summarizeRowCosts(groupRows.map((row) => row.cost)).status,
    };
  });

  const inputTokenValues = rows.map((row) => row.inputTokens).filter((value): value is number => value != null);
  const outputTokenValues = rows.map((row) => row.outputTokens).filter((value): value is number => value != null);
  const latencyValues = rows.map((row) => row.latencyMs).filter((value): value is number => value != null);
  const missingUsageCount = rows.filter((row) => row.cost.reason === MISSING_USAGE_REASON).length;
  const unknownCostCount = rows.filter((row) => row.cost.status === "unknown").length;
  const roundRate = (value: number) => Math.round(value * 10_000) / 10_000;
  const requestLatencies = requestAttempts.map((row) => row.latencyMs).filter((value): value is number => value != null);
  const requestTelemetry = {
    attempts: requestAttempts.length,
    succeeded: requestAttempts.filter((row) => row.status === "succeeded").length,
    failed: requestAttempts.filter((row) => row.status === "failed").length,
    started: requestAttempts.filter((row) => row.status === "started").length,
    retryAttempts: requestAttempts.filter((row) => row.attempt > 1).length,
    missingUsage: requestAttempts.filter((row) => row.tokensPrompt == null || row.tokensCompletion == null).length,
    inputTokens: requestAttempts.reduce((sum, row) => sum + (row.tokensPrompt ?? 0), 0),
    outputTokens: requestAttempts.reduce((sum, row) => sum + (row.tokensCompletion ?? 0), 0),
    totalTokens: requestAttempts.reduce((sum, row) => sum + (row.tokensTotal ?? 0), 0),
    medianLatencyMs: percentile(requestLatencies, 0.5),
    p95LatencyMs: percentile(requestLatencies, 0.95),
  };
  if (requestTelemetry.failed > 0) warnings.push(`${requestTelemetry.failed} LLM request attempt(s) failed; their latency is included, but unknown usage is not priced`);

  const fetchedAt = input.pricing
    ? input.pricing.rates.reduce<Date | null>((latest, rate) => (rate.fetchedAt && (!latest || rate.fetchedAt > latest) ? rate.fetchedAt : latest), null) ??
      input.pricing.snapshot.completedAt ??
      input.pricing.snapshot.createdAt
    : null;

  const storedEstimate = (run.costEstimate ?? null) as StoredRunEstimate | null;
  const actualTokens = {
    inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
  };
  const estimateVsActual: EstimateVsActual | null =
    storedEstimate && typeof storedEstimate === "object" && storedEstimate.estimate
      ? {
          estimate: storedEstimate.estimate,
          actual: summary.total,
          absoluteVarianceUsd:
            storedEstimate.estimate.total.costUsd != null && summary.total.costUsd != null
              ? roundMoney(summary.total.costUsd - storedEstimate.estimate.total.costUsd)
              : null,
          percentageVariance:
            storedEstimate.estimate.total.costUsd != null && storedEstimate.estimate.total.costUsd !== 0 && summary.total.costUsd != null
              ? Math.round(((summary.total.costUsd - storedEstimate.estimate.total.costUsd) / storedEstimate.estimate.total.costUsd) * 10_000) / 100
              : null,
          cases: { estimated: storedEstimate.cases ?? 0, actual: input.jobs.length },
          tokens: {
            estimated: storedEstimate.tokens ?? null,
            actual: actualTokens,
            difference: storedEstimate.tokens
              ? { inputTokens: actualTokens.inputTokens - storedEstimate.tokens.inputTokens, outputTokens: actualTokens.outputTokens - storedEstimate.tokens.outputTokens }
              : null,
          },
          assumptions: storedEstimate.assumptions ?? [],
        }
      : null;

  return {
    runId: run.id,
    currency: run.costCurrency || "USD",
    status,
    pricing: {
      snapshotId: input.pricing?.snapshot.id ?? run.pricingSnapshotId ?? null,
      source: "official",
      fetchedAt,
    },
    summary,
    byReading,
    byUser,
    byModel,
    tokens: {
      input: { median: percentile(inputTokenValues, 0.5), p95: percentile(inputTokenValues, 0.95) },
      output: { median: percentile(outputTokenValues, 0.5), p95: percentile(outputTokenValues, 0.95) },
    },
    latencyMs: { median: percentile(latencyValues, 0.5), p95: percentile(latencyValues, 0.95) },
    missingUsageRate: rows.length ? roundRate(missingUsageCount / rows.length) : null,
    unknownCostRate: rows.length ? roundRate(unknownCostCount / rows.length) : null,
    warnings,
    provenance: {
      baselineRowsExcluded,
      retryRowsExcluded,
      rowsWithProviderCost: rows.filter((row) => row.cost.source === "provider").length,
      rowsPricedFromSnapshot: rows.filter((row) => row.cost.source === "snapshot").length,
      rowsUnknown: rows.filter((row) => row.cost.status === "unknown").length,
    },
    requestTelemetry,
    estimateVsActual,
  };
}

// ---------------------------------------------------------------------------
// Pre-run estimate — ZERO provider calls. Token envelopes come from historical
// medians of past completed runs (same reading type when possible, else the
// global median); with no history the estimate remains unknown.
// ---------------------------------------------------------------------------

export interface UsageMedian {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageHistory {
  byReadingType: Record<string, UsageMedian>;
  global: UsageMedian | null;
}

export type UsageHistoryRow = { readingType: string | null; tokensPrompt: number | null; tokensCompletion: number | null };

export function medianUsageHistory(rows: readonly UsageHistoryRow[]): UsageHistory {
  const groups = new Map<string, { input: number[]; output: number[] }>();
  const globalInput: number[] = [];
  const globalOutput: number[] = [];
  for (const row of rows) {
    const key = row.readingType ?? "unknown";
    if (!groups.has(key)) groups.set(key, { input: [], output: [] });
    const group = groups.get(key)!;
    if (row.tokensPrompt != null) {
      group.input.push(row.tokensPrompt);
      globalInput.push(row.tokensPrompt);
    }
    if (row.tokensCompletion != null) {
      group.output.push(row.tokensCompletion);
      globalOutput.push(row.tokensCompletion);
    }
  }
  const byReadingType: Record<string, UsageMedian> = {};
  for (const [key, group] of groups) {
    const inputTokens = percentile(group.input, 0.5);
    const outputTokens = percentile(group.output, 0.5);
    if (inputTokens != null && outputTokens != null) byReadingType[key] = { inputTokens, outputTokens };
  }
  const globalInputMedian = percentile(globalInput, 0.5);
  const globalOutputMedian = percentile(globalOutput, 0.5);
  return {
    byReadingType,
    global: globalInputMedian != null && globalOutputMedian != null ? { inputTokens: globalInputMedian, outputTokens: globalOutputMedian } : null,
  };
}

export interface EstimateCaseInput {
  id: string;
  readingType: string;
  readingSubtype: string | null;
  inputSnapshot: unknown;
}

export interface BuildEstimateInput {
  cases: EstimateCaseInput[];
  candidateModel: string;
  judgeProvider: string | null;
  judgeModel: string | null;
  secondaryJudgeProvider?: string | null;
  secondaryJudgeModel?: string | null;
  secondaryJudgeSampleRate: number;
  candidateHistory: UsageHistory;
  judgeHistory: UsageHistory;
  rates: PricingRateRecord[];
  snapshotId: string | null;
}

function priceEstimatedTokens(inputTokens: number, outputTokens: number, rate: PricingRateRecord | null): CostComponent {
  if (!rate) return { costUsd: null, status: "unknown" };
  if (rate.inputUsdPerMillion == null || rate.outputUsdPerMillion == null) return { costUsd: null, status: "unknown" };
  return { costUsd: roundMoney((inputTokens * rate.inputUsdPerMillion + outputTokens * rate.outputUsdPerMillion) / 1_000_000), status: "known" };
}

export function buildRunEstimate(input: BuildEstimateInput): StoredRunEstimate {
  const assumptions: string[] = [];
  const standardRates = input.rates.filter((rate) => (rate.usageMode || "standard") === "standard");

  // The candidate model runs behind the Cosmic Guidance generation endpoint,
  // so its provider is matched by model id from the snapshot catalog.
  const candidateRates = standardRates.filter((rate) => rate.modelId === input.candidateModel);
  const candidateRate = candidateRates[0] ?? null;
  if (candidateRates.length > 1) assumptions.push(`candidate model "${input.candidateModel}" has rates from multiple providers; priced with ${candidateRate.provider}`);
  if (!candidateRate) assumptions.push(`no pricing rate for candidate model "${input.candidateModel}" — candidate cost is unknown, never zero`);

  const judgeRate =
    input.judgeProvider && input.judgeModel
      ? standardRates.find((rate) => rate.provider === input.judgeProvider && rate.modelId === input.judgeModel) ?? null
      : null;
  if (!input.judgeProvider || !input.judgeModel) assumptions.push("primary judge model could not be resolved from the active config — judge cost is unknown");
  else if (!judgeRate) assumptions.push(`no pricing rate for primary judge ${input.judgeProvider}/${input.judgeModel} — judge cost is unknown, never zero`);

  const secondaryJudgeRate =
    input.secondaryJudgeSampleRate === 0
      ? judgeRate
      : input.secondaryJudgeProvider && input.secondaryJudgeModel
        ? standardRates.find((rate) => rate.provider === input.secondaryJudgeProvider && rate.modelId === input.secondaryJudgeModel) ?? null
        : null;
  if (input.secondaryJudgeSampleRate > 0) {
    if (!input.secondaryJudgeProvider || !input.secondaryJudgeModel) assumptions.push("secondary judge model could not be resolved from the active config — secondary judge cost is unknown");
    else if (!secondaryJudgeRate) assumptions.push(`no pricing rate for secondary judge ${input.secondaryJudgeProvider}/${input.secondaryJudgeModel} — secondary judge cost is unknown, never zero`);
  }

  let candidateHistoryUsed = false;
  let judgeHistoryUsed = false;
  let candidateInput = 0;
  let candidateOutput = 0;
  let judgeInput = 0;
  let judgeOutput = 0;
  let candidateEnvelopeComplete = true;
  let judgeEnvelopeComplete = true;
  for (const datasetCase of input.cases) {
    const candidateMedian = input.candidateHistory.byReadingType[datasetCase.readingType] ?? input.candidateHistory.global;
    if (candidateMedian) candidateHistoryUsed = true;
    if (!candidateMedian) candidateEnvelopeComplete = false;
    else {
      candidateInput += candidateMedian.inputTokens;
      candidateOutput += candidateMedian.outputTokens;
    }
    const judgeMedian = input.judgeHistory.byReadingType[datasetCase.readingType] ?? input.judgeHistory.global;
    if (judgeMedian) judgeHistoryUsed = true;
    if (!judgeMedian) judgeEnvelopeComplete = false;
    else {
      judgeInput += judgeMedian.inputTokens * 2;
      judgeOutput += judgeMedian.outputTokens * 2;
    }
  }
  if (candidateHistoryUsed) assumptions.push("candidate token envelope uses historical medians from past completed runs (same reading type when available, else global median)");
  else assumptions.push("no candidate generation token history is available; candidate estimate is unknown");
  if (judgeHistoryUsed) assumptions.push("two evidence-judge calls per case (current and candidate) use historical medians from past completed runs (same reading type when available, else global median)");
  else assumptions.push("no primary judge token history is available; judge estimate is unknown");
  assumptions.push(`secondary judge estimated as primary judge × secondaryJudgeSampleRate (${input.secondaryJudgeSampleRate})`);
  assumptions.push("cache-read/cache-write pricing is not included in estimates");

  const candidate = candidateEnvelopeComplete ? priceEstimatedTokens(candidateInput, candidateOutput, candidateRate) : { costUsd: null, status: "unknown" as const };
  const primaryJudge = judgeEnvelopeComplete ? priceEstimatedTokens(judgeInput, judgeOutput, judgeRate) : { costUsd: null, status: "unknown" as const };
  const secondaryJudge = input.secondaryJudgeSampleRate === 0
    ? { costUsd: 0, status: "known" as const }
    : judgeEnvelopeComplete
      ? priceEstimatedTokens(judgeInput * input.secondaryJudgeSampleRate, judgeOutput * input.secondaryJudgeSampleRate, secondaryJudgeRate)
      : { costUsd: null, status: "unknown" as const };
  const components = [candidate, primaryJudge, secondaryJudge];
  const pricedComponents = components.filter((component) => component.status === "known");
  const total: CostComponent =
    pricedComponents.length === 0
      ? { costUsd: null, status: "unknown" }
      : {
          costUsd: roundMoney(pricedComponents.reduce((sum, component) => sum + (component.costUsd ?? 0), 0)),
          status: pricedComponents.length === components.length ? "known" : "partial",
        };

  return {
    cases: input.cases.length,
    estimate: { candidate, primaryJudge, secondaryJudge, total },
    tokens: {
      inputTokens: Math.round(candidateInput + judgeInput * (1 + input.secondaryJudgeSampleRate)),
      outputTokens: Math.round(candidateOutput + judgeOutput * (1 + input.secondaryJudgeSampleRate)),
    },
    assumptions,
    pricedWith: { snapshotId: input.snapshotId },
  };
}

// ---------------------------------------------------------------------------
// Data access — the aggregation/estimate logic above is DB-agnostic so unit
// tests run against in-memory fakes; production uses the drizzle source.
// ---------------------------------------------------------------------------

export interface CostAnalysisSource {
  getRun(runId: string): Promise<RunRow | null>;
  getRunJobs(runId: string): Promise<RunJobContext[]>;
  getGenerations(jobIds: string[]): Promise<GenerationRow[]>;
  getJudgeScores(jobIds: string[]): Promise<JudgeScoreRow[]>;
  getRequestAttempts?(jobIds: string[]): Promise<LlmRequestAttemptRow[]>;
}

export interface CostEstimateSource {
  resolveEstimateSelection(input: {
    comparisonId: string;
    userKeys?: string[];
    readingTypes?: string[];
    readingSubtypes?: string[];
  }): Promise<{ candidateModel: string; configVersionId: string; secondaryJudgeSampleRate: number; cases: EstimateCaseInput[] }>;
  getJudgeBinding(configVersionId?: string): Promise<{ provider: string; model: string } | null>;
  getSecondaryJudgeBinding?(configVersionId?: string): Promise<{ provider: string; model: string } | null>;
  getCandidateHistory(): Promise<UsageHistoryRow[]>;
  getJudgeHistory(): Promise<UsageHistoryRow[]>;
}

export function createDrizzleCostSource(db: Db): CostAnalysisSource & CostEstimateSource {
  return {
    async getRun(runId) {
      const [run] = await db.select().from(evalComparisonRuns).where(eq(evalComparisonRuns.id, runId));
      return run ?? null;
    },
    async getRunJobs(runId) {
      const rows = await db
        .select({ job: evalJobs, case: evalDatasetCases, subjectKey: evalDatasetSubjects.subjectKey })
        .from(evalJobs)
        .innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId))
        .leftJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
        .where(eq(evalJobs.runId, runId));
      return rows.map(({ job, case: datasetCase, subjectKey }) => ({
        job: { id: job.id, status: job.status, caseId: job.caseId },
        readingType: datasetCase.readingType ?? datasetCase.track,
        readingSubtype: datasetCase.readingSubtype,
        subjectKey,
      }));
    },
    async getGenerations(jobIds) {
      return jobIds.length ? db.select().from(evalGenerations).where(inArray(evalGenerations.jobId, jobIds)) : [];
    },
    async getJudgeScores(jobIds) {
      if (!jobIds.length) return [];
      const rows = await db.select().from(evalJudgementsV2).where(inArray(evalJudgementsV2.jobId, jobIds));
      const currentRows = rows.map((row) => {
        const usage = row.usage as Record<string, unknown>;
        const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
        return {
          id: row.id,
          jobId: row.jobId!,
          judgeRole: row.judgeRole,
          provider: row.judgeProvider,
          model: row.judgeModel,
          tokensPrompt: number(usage.inputTokens),
          tokensCompletion: number(usage.outputTokens),
          tokensTotal: number(usage.totalTokens),
          tokensCached: number(usage.cacheReadInputTokens),
          tokensCacheWrite: number(usage.cacheWriteInputTokens),
          tokensReasoning: number(usage.reasoningTokens),
          latencyMs: row.latencyMs,
          costUsd: row.costUsd,
          attempt: row.attempt,
          endpoint: null,
          providerBatchId: null,
          providerMetadata: { usage },
        };
      }) as unknown as JudgeScoreRow[];
      const represented = new Set(currentRows.map((row) => `${row.jobId}|${row.judgeRole}`));
      const historical = await db.select().from(evalJudgeScores).where(inArray(evalJudgeScores.jobId, jobIds));
      return [...currentRows, ...historical.filter((row) => !represented.has(`${row.jobId}|${row.judgeRole}`))] as JudgeScoreRow[];
    },
    async getRequestAttempts(jobIds) {
      return jobIds.length ? db.select().from(evalLlmRequestAttempts).where(inArray(evalLlmRequestAttempts.jobId, jobIds)) : [];
    },
    async resolveEstimateSelection(input) {
      const selection = await resolveRunCaseSelection(db, input);
      return {
        candidateModel: selection.comparison.candidateModel,
        configVersionId: selection.comparison.configVersionId,
        secondaryJudgeSampleRate: selection.comparison.secondaryJudgeSampleRate,
        cases: selection.cases.map((datasetCase) => ({
          id: datasetCase.id,
          readingType: datasetCase.readingType ?? datasetCase.track,
          readingSubtype: datasetCase.readingSubtype,
          inputSnapshot: datasetCase.inputSnapshot,
        })),
      };
    },
    async getJudgeBinding(configVersionId?: string) {
      const { value } = configVersionId ? await getConfigVersion(db, configVersionId) : await getActiveConfig(db, "global");
      return { provider: value.providers.primary_judge.provider, model: value.providers.primary_judge.model };
    },
    async getSecondaryJudgeBinding(configVersionId?: string) {
      const { value } = configVersionId ? await getConfigVersion(db, configVersionId) : await getActiveConfig(db, "global");
      return { provider: value.providers.secondary_judge.provider, model: value.providers.secondary_judge.model };
    },
    async getCandidateHistory() {
      const rows = await db
        .select({
          readingType: evalDatasetCases.readingType,
          track: evalDatasetCases.track,
          tokensPrompt: evalGenerations.tokensPrompt,
          tokensCompletion: evalGenerations.tokensCompletion,
        })
        .from(evalGenerations)
        .innerJoin(evalJobs, eq(evalJobs.id, evalGenerations.jobId))
        .innerJoin(evalComparisonRuns, eq(evalComparisonRuns.id, evalJobs.runId))
        .innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId))
        .where(and(eq(evalComparisonRuns.status, "completed"), eq(evalGenerations.arm, "candidate")));
      return rows.map((row) => ({ readingType: row.readingType ?? row.track, tokensPrompt: row.tokensPrompt, tokensCompletion: row.tokensCompletion }));
    },
    async getJudgeHistory() {
      try {
        const rows = await db.select({ readingType: evalDatasetCases.readingType, track: evalDatasetCases.track, usage: evalJudgementsV2.usage }).from(evalJudgementsV2).innerJoin(evalJobs, eq(evalJobs.id, evalJudgementsV2.jobId)).innerJoin(evalComparisonRuns, eq(evalComparisonRuns.id, evalJobs.runId)).innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId)).where(and(eq(evalComparisonRuns.status, "completed"), eq(evalJudgementsV2.judgeRole, "primary")));
        return rows.map((row) => { const usage = row.usage as Record<string, unknown>; return { readingType: row.readingType ?? row.track, tokensPrompt: typeof usage.inputTokens === "number" ? usage.inputTokens : null, tokensCompletion: typeof usage.outputTokens === "number" ? usage.outputTokens : null }; });
      } catch {
        const rows = await db.select().from(evalJudgeScores).where(eq(evalJudgeScores.judgeRole, "primary"));
        return rows.map((row) => ({ readingType: null, tokensPrompt: row.tokensPrompt, tokensCompletion: row.tokensCompletion }));
      }
    },
  };
}

export interface CostServiceDeps {
  pricingStore?: PricingStore;
  source?: CostAnalysisSource & Partial<CostEstimateSource>;
}

export async function getRunCostAnalysis(db: Db, runId: string, deps: CostServiceDeps = {}): Promise<RunCostAnalysis> {
  const store = deps.pricingStore ?? createDrizzlePricingStore(db);
  const source = deps.source ?? createDrizzleCostSource(db);
  const run = await source.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const jobs = await source.getRunJobs(runId);
  const jobIds = jobs.map((context) => context.job.id);
  const generations = await source.getGenerations(jobIds);
  const judgeScores = await source.getJudgeScores(jobIds);
  const requestAttempts = await source.getRequestAttempts?.(jobIds) ?? [];

  // Historical immutability (spec §4.3): only the snapshot recorded on the run
  // may price it. Runs created before pricing snapshots remain unpriced rather
  // than being silently reinterpreted with a newer rate table.
  let pricing: { snapshot: PricingSnapshotRecord; rates: PricingRateRecord[] } | null = null;
  if (run.pricingSnapshotId) {
    pricing = await getSnapshot(store, run.pricingSnapshotId);
  }

  return analyzeRunCost({ run, jobs, generations, judgeScores, requestAttempts, pricing });
}

export interface EstimateRunInput {
  comparisonId: string;
  userKeys?: string[];
  readingTypes?: string[];
  readingSubtypes?: string[];
}

export async function estimateRunCost(db: Db, input: EstimateRunInput, deps: CostServiceDeps = {}): Promise<StoredRunEstimate> {
  const store = deps.pricingStore ?? createDrizzlePricingStore(db);
  const source = deps.source ?? createDrizzleCostSource(db);
  if (!source.resolveEstimateSelection || !source.getJudgeBinding || !source.getCandidateHistory || !source.getJudgeHistory) {
    throw new Error("estimate data source is not configured");
  }

  // Resolves the case set with exactly the same validation as run creation.
  const selection = await source.resolveEstimateSelection(input);
  const judgeBinding = await source.getJudgeBinding(selection.configVersionId);
  const secondaryJudgeBinding = await source.getSecondaryJudgeBinding?.(selection.configVersionId) ?? judgeBinding;
  const candidateHistoryRows = await source.getCandidateHistory();
  const judgeHistoryRows = await source.getJudgeHistory();

  const latest = await getLatestValidSnapshot(store);
  const rates = latest ? (await getSnapshot(store, latest.id))?.rates ?? [] : [];

  return buildRunEstimate({
    cases: selection.cases,
    candidateModel: selection.candidateModel,
    judgeProvider: judgeBinding?.provider ?? null,
    judgeModel: judgeBinding?.model ?? null,
    secondaryJudgeProvider: secondaryJudgeBinding?.provider ?? null,
    secondaryJudgeModel: secondaryJudgeBinding?.model ?? null,
    secondaryJudgeSampleRate: selection.secondaryJudgeSampleRate,
    candidateHistory: medianUsageHistory(candidateHistoryRows),
    judgeHistory: medianUsageHistory(judgeHistoryRows),
    rates,
    snapshotId: latest?.id ?? null,
  });
}
