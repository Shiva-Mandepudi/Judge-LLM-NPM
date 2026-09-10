import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalPricingRates, evalPricingSnapshots, pricingUsageModes } from "../../shared/schema.js";

// Official prices are curated in config/pricing-catalog.yaml (reviewed in git,
// with source URLs and effective dates) — never fetched live as a price source
// and never read from config/models.yaml (its rates: {} is unresolved).
// A sync validates the catalog, hashes it, and appends an immutable snapshot.
// Rates are real/nullable: unpublished fields stay NULL, never 0; money values
// are rounded only at display time (a later phase).

export const supportedPricingProviders = ["openai", "anthropic", "gemini"] as const;
export type PricingProvider = (typeof supportedPricingProviders)[number];

export interface CatalogEntry {
  provider: PricingProvider;
  modelId: string;
  usageMode: (typeof pricingUsageModes)[number];
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  currency: "USD";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceUrl: string | null;
}

export interface PricingCatalog {
  asOf: string | null;
  providers: Partial<Record<PricingProvider, { pricingPageUrl?: string }>>;
  entries: CatalogEntry[];
}

export class CatalogValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`pricing catalog failed validation:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "CatalogValidationError";
  }
}

const nullableRate = z
  .number()
  .finite()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? null);
const nullableString = z
  .string()
  .trim()
  .min(1)
  .nullish()
  .transform((v) => v ?? null);

const catalogEntrySchema = z.object({
  provider: z.enum(supportedPricingProviders),
  modelId: z.string().trim().min(1),
  usageMode: z.enum(pricingUsageModes).default("standard"),
  input: nullableRate,
  output: nullableRate,
  cacheRead: nullableRate,
  cacheWrite: nullableRate,
  currency: z.literal("USD").default("USD"),
  effectiveFrom: nullableString,
  effectiveTo: nullableString,
  sourceUrl: nullableString,
});

const catalogSchema = z.object({
  asOf: nullableString,
  providers: z
    .record(z.object({ pricingPageUrl: z.string().trim().min(1).optional() }))
    .default({}),
  entries: z.array(catalogEntrySchema).min(1, "catalog must contain at least one entry"),
});

// Validates the parsed YAML. Throws CatalogValidationError listing EVERY issue
// (not just the first) so an operator can fix the file in one pass.
export function validateCatalog(raw: unknown): PricingCatalog {
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new CatalogValidationError(issues);
  }
  const issues: string[] = [];
  for (const key of Object.keys(parsed.data.providers)) {
    if (!supportedPricingProviders.includes(key as PricingProvider)) {
      issues.push(`providers.${key}: not a supported provider (${supportedPricingProviders.join(" | ")})`);
    }
  }
  const seen = new Set<string>();
  parsed.data.entries.forEach((entry, i) => {
    const key = `${entry.provider}|${entry.modelId}|${entry.usageMode}`;
    if (seen.has(key)) issues.push(`entries[${i}]: duplicate provider/modelId/usageMode "${key}"`);
    seen.add(key);
  });
  if (issues.length > 0) throw new CatalogValidationError(issues);
  return parsed.data as PricingCatalog;
}

// Canonical serialization: entries sorted by (provider, modelId, usageMode),
// fixed key order — so the hash depends on catalog CONTENT, not file layout.
export function canonicalizeCatalog(catalog: PricingCatalog): string {
  const entries = [...catalog.entries]
    .sort((a, b) =>
      `${a.provider}|${a.modelId}|${a.usageMode}`.localeCompare(`${b.provider}|${b.modelId}|${b.usageMode}`)
    )
    .map((e) => ({
      provider: e.provider,
      modelId: e.modelId,
      usageMode: e.usageMode,
      input: e.input,
      output: e.output,
      cacheRead: e.cacheRead,
      cacheWrite: e.cacheWrite,
      currency: e.currency,
      effectiveFrom: e.effectiveFrom,
      effectiveTo: e.effectiveTo,
      sourceUrl: e.sourceUrl,
    }));
  return JSON.stringify({ asOf: catalog.asOf ?? null, entries });
}

export function computeSourceHash(catalog: PricingCatalog): string {
  return createHash("sha256").update(canonicalizeCatalog(catalog), "utf8").digest("hex");
}

// Parses and validates config/pricing-catalog.yaml. Validation errors surface
// as CatalogValidationError; a missing/malformed file throws as-is (both are
// handled by syncOfficialPrices, which records a 'failed' snapshot).
export function loadPricingCatalog(configDir: string): PricingCatalog {
  const raw = parseYaml(readFileSync(path.join(configDir, "pricing-catalog.yaml"), "utf8"));
  return validateCatalog(raw);
}

// ---------------------------------------------------------------------------
// Store abstraction — the sync logic is DB-agnostic so unit tests run against
// an in-memory store with no Postgres. Production uses createDrizzlePricingStore.
// ---------------------------------------------------------------------------

export interface PricingSnapshotRecord {
  id: string;
  status: string;
  triggeredBy: string;
  createdAt: Date;
  completedAt: Date | null;
  sourceSummary: unknown;
  errorSummary: string | null;
}

export interface PricingRateRecord {
  id: string;
  snapshotId: string;
  provider: string;
  modelId: string;
  usageMode: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cacheReadUsdPerMillion: number | null;
  cacheWriteUsdPerMillion: number | null;
  currency: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceUrl: string | null;
  sourceHash: string | null;
  fetchedAt: Date | null;
  createdAt: Date;
}

export type NewPricingRate = Omit<PricingRateRecord, "id" | "snapshotId" | "createdAt">;

export interface PricingStore {
  latestValidSnapshot(): Promise<PricingSnapshotRecord | null>;
  latestFailedSnapshot(): Promise<PricingSnapshotRecord | null>;
  recentSnapshots(limit: number): Promise<PricingSnapshotRecord[]>;
  snapshotById(id: string): Promise<PricingSnapshotRecord | null>;
  ratesForSnapshot(snapshotId: string): Promise<PricingRateRecord[]>;
  insertFailedSnapshot(input: { triggeredBy: string; errorSummary: string; sourceSummary?: unknown }): Promise<PricingSnapshotRecord>;
  insertValidSnapshotWithRates(
    input: { triggeredBy: string; sourceSummary: unknown },
    rates: NewPricingRate[]
  ): Promise<PricingSnapshotRecord>;
}

export function createDrizzlePricingStore(db: Db): PricingStore {
  return {
    async latestValidSnapshot() {
      const rows = await db
        .select()
        .from(evalPricingSnapshots)
        .where(eq(evalPricingSnapshots.status, "valid"))
        .orderBy(desc(evalPricingSnapshots.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
    async latestFailedSnapshot() {
      const rows = await db
        .select()
        .from(evalPricingSnapshots)
        .where(eq(evalPricingSnapshots.status, "failed"))
        .orderBy(desc(evalPricingSnapshots.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
    async recentSnapshots(limit) {
      return db.select().from(evalPricingSnapshots).orderBy(desc(evalPricingSnapshots.createdAt)).limit(limit);
    },
    async snapshotById(id) {
      const rows = await db.select().from(evalPricingSnapshots).where(eq(evalPricingSnapshots.id, id)).limit(1);
      return rows[0] ?? null;
    },
    async ratesForSnapshot(snapshotId) {
      return db.select().from(evalPricingRates).where(eq(evalPricingRates.snapshotId, snapshotId));
    },
    async insertFailedSnapshot(input) {
      const rows = await db
        .insert(evalPricingSnapshots)
        .values({
          status: "failed",
          triggeredBy: input.triggeredBy,
          errorSummary: input.errorSummary,
          sourceSummary: input.sourceSummary ?? null,
          completedAt: new Date(),
        })
        .returning();
      return rows[0];
    },
    async insertValidSnapshotWithRates(input, rates) {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(evalPricingSnapshots)
          .values({
            status: "valid",
            triggeredBy: input.triggeredBy,
            sourceSummary: input.sourceSummary,
            completedAt: new Date(),
          })
          .returning();
        const snapshot = inserted[0];
        if (rates.length > 0) {
          await tx.insert(evalPricingRates).values(rates.map((rate) => ({ ...rate, snapshotId: snapshot.id })));
        }
        return snapshot;
      });
    },
  };
}

// In-memory store for unit tests (and for local tooling that wants to exercise
// sync logic without a database).
export function createInMemoryPricingStore(): PricingStore & {
  snapshots: PricingSnapshotRecord[];
  rates: PricingRateRecord[];
} {
  const snapshots: PricingSnapshotRecord[] = [];
  const rates: PricingRateRecord[] = [];
  let seq = 0;
  const nextId = () => `mem-${++seq}`;
  const latestByStatus = (status: string) =>
    snapshots.filter((s) => s.status === status).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  return {
    snapshots,
    rates,
    latestValidSnapshot: async () => latestByStatus("valid"),
    latestFailedSnapshot: async () => latestByStatus("failed"),
    recentSnapshots: async (limit) =>
      [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit),
    snapshotById: async (id) => snapshots.find((s) => s.id === id) ?? null,
    ratesForSnapshot: async (snapshotId) => rates.filter((r) => r.snapshotId === snapshotId),
    async insertFailedSnapshot(input) {
      const snapshot: PricingSnapshotRecord = {
        id: nextId(),
        status: "failed",
        triggeredBy: input.triggeredBy,
        createdAt: new Date(),
        completedAt: new Date(),
        sourceSummary: input.sourceSummary ?? null,
        errorSummary: input.errorSummary,
      };
      snapshots.push(snapshot);
      return snapshot;
    },
    async insertValidSnapshotWithRates(input, newRates) {
      const snapshot: PricingSnapshotRecord = {
        id: nextId(),
        status: "valid",
        triggeredBy: input.triggeredBy,
        createdAt: new Date(),
        completedAt: new Date(),
        sourceSummary: input.sourceSummary,
        errorSummary: null,
      };
      snapshots.push(snapshot);
      for (const rate of newRates) {
        rates.push({ ...rate, id: nextId(), snapshotId: snapshot.id, createdAt: new Date() });
      }
      return snapshot;
    },
  };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface ProviderDriftResult {
  pricingPageUrl: string;
  reachable: boolean;
  httpStatus?: number;
  error?: string;
}

export interface SyncCounts {
  added: number;
  updated: number;
  unchanged: number;
  unresolved: number;
}

export type SyncResult =
  | { status: "failed"; snapshotId: string | null; errors: string[] }
  | { status: "unchanged"; snapshotId: string; sourceHash: string; counts: SyncCounts; providers: Record<string, ProviderDriftResult> }
  | { status: "synced"; snapshotId: string; sourceHash: string; counts: SyncCounts; providers: Record<string, ProviderDriftResult> };

function entryKey(provider: string, modelId: string, usageMode: string): string {
  return `${provider}|${modelId}|${usageMode}`;
}

function isUnresolved(entry: CatalogEntry): boolean {
  return entry.input === null || entry.output === null || entry.cacheRead === null || entry.cacheWrite === null;
}

export function isUnresolvedRate(rate: Pick<PricingRateRecord, "inputUsdPerMillion" | "outputUsdPerMillion" | "cacheReadUsdPerMillion" | "cacheWriteUsdPerMillion">): boolean {
  return (
    rate.inputUsdPerMillion === null ||
    rate.outputUsdPerMillion === null ||
    rate.cacheReadUsdPerMillion === null ||
    rate.cacheWriteUsdPerMillion === null
  );
}

// Rates are stored as `real` (float4), so a DB round-trip can shift a decimal
// like 0.3 by ~1e-8. Compare with a small tolerance so an unchanged catalog
// never produces spurious "updated" counts; null stays strictly null.
function ratesEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

// The optional drift check only proves each provider's pricing page is
// reachable; a network or parse failure annotates source_summary and NEVER
// blocks an otherwise valid sync. No API keys are involved.
export async function checkProviderPages(
  providers: PricingCatalog["providers"],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<Record<string, ProviderDriftResult>> {
  const results: Record<string, ProviderDriftResult> = {};
  for (const [provider, info] of Object.entries(providers)) {
    const url = info?.pricingPageUrl;
    if (!url) continue;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      results[provider] = { pricingPageUrl: url, reachable: response.ok, httpStatus: response.status };
    } catch (error) {
      results[provider] = { pricingPageUrl: url, reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return results;
}

export interface SyncOptions {
  rawCatalog: unknown; // parsed YAML, validated inside so failures are recorded
  triggeredBy: string;
  checkDrift?: boolean; // default true; disable in tests/offline runs
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function syncOfficialPrices(store: PricingStore, options: SyncOptions): Promise<SyncResult> {
  const { triggeredBy } = options;

  let catalog: PricingCatalog;
  try {
    catalog = validateCatalog(options.rawCatalog);
  } catch (error) {
    const issues = error instanceof CatalogValidationError ? error.issues : [error instanceof Error ? error.message : String(error)];
    // A failed validation must never touch the previous valid snapshot — it
    // only appends a 'failed' snapshot row with the actionable error list.
    const failed = await store.insertFailedSnapshot({ triggeredBy, errorSummary: issues.join("\n") });
    return { status: "failed", snapshotId: failed.id, errors: issues };
  }

  const sourceHash = computeSourceHash(catalog);
  const previous = await store.latestValidSnapshot();
  const previousHash =
    previous && typeof previous.sourceSummary === "object" && previous.sourceSummary !== null
      ? (previous.sourceSummary as { catalogHash?: unknown }).catalogHash
      : undefined;

  const checkDrift = options.checkDrift ?? true;
  const drift = checkDrift ? await checkProviderPages(catalog.providers, options.fetchImpl) : {};

  if (previous && previousHash === sourceHash) {
    const unresolved = catalog.entries.filter(isUnresolved).length;
    return {
      status: "unchanged",
      snapshotId: previous.id,
      sourceHash,
      counts: { added: 0, updated: 0, unchanged: catalog.entries.length, unresolved },
      providers: drift,
    };
  }

  const previousRates = previous ? await store.ratesForSnapshot(previous.id) : [];
  const previousByKey = new Map(previousRates.map((r) => [entryKey(r.provider, r.modelId, r.usageMode), r]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let unresolved = 0;
  for (const entry of catalog.entries) {
    if (isUnresolved(entry)) unresolved += 1;
    const prev = previousByKey.get(entryKey(entry.provider, entry.modelId, entry.usageMode));
    if (!prev) {
      added += 1;
      continue;
    }
    const changed =
      !ratesEqual(prev.inputUsdPerMillion, entry.input) ||
      !ratesEqual(prev.outputUsdPerMillion, entry.output) ||
      !ratesEqual(prev.cacheReadUsdPerMillion, entry.cacheRead) ||
      !ratesEqual(prev.cacheWriteUsdPerMillion, entry.cacheWrite) ||
      prev.effectiveFrom !== entry.effectiveFrom ||
      prev.effectiveTo !== entry.effectiveTo;
    if (changed) updated += 1;
    else unchanged += 1;
  }

  const counts: SyncCounts = { added, updated, unchanged, unresolved };
  const sourceSummary = {
    catalogHash: sourceHash,
    asOf: catalog.asOf,
    entryCount: catalog.entries.length,
    counts,
    providers: drift,
    previousSnapshotId: previous?.id ?? null,
  };
  const fetchedAt = options.now?.() ?? new Date();
  const snapshot = await store.insertValidSnapshotWithRates(
    { triggeredBy, sourceSummary },
    catalog.entries.map((entry) => ({
      provider: entry.provider,
      modelId: entry.modelId,
      usageMode: entry.usageMode,
      inputUsdPerMillion: entry.input,
      outputUsdPerMillion: entry.output,
      cacheReadUsdPerMillion: entry.cacheRead,
      cacheWriteUsdPerMillion: entry.cacheWrite,
      currency: entry.currency,
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      sourceUrl: entry.sourceUrl,
      sourceHash,
      fetchedAt,
    }))
  );
  return { status: "synced", snapshotId: snapshot.id, sourceHash, counts, providers: drift };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLatestValidSnapshot(store: PricingStore): Promise<PricingSnapshotRecord | null> {
  return store.latestValidSnapshot();
}

export interface PricingStatus {
  latestValidSnapshot: { id: string; createdAt: Date; sourceHash: string | null; asOf: string | null } | null;
  providers: Record<string, { models: number; entries: number }>;
  unresolvedModelCount: number;
  lastFailedSync: { id: string; createdAt: Date; errorSummary: string | null } | null;
  recentSnapshots: Array<{
    id: string;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
    rateCount: number;
    unresolvedCount: number;
  }>;
}

export async function getPricingStatus(store: PricingStore): Promise<PricingStatus> {
  const latest = await store.latestValidSnapshot();
  const providers: Record<string, { models: number; entries: number }> = {};
  let unresolvedModelCount = 0;
  if (latest) {
    const rates = await store.ratesForSnapshot(latest.id);
    const modelsByProvider = new Map<string, Set<string>>();
    for (const rate of rates) {
      if (!modelsByProvider.has(rate.provider)) modelsByProvider.set(rate.provider, new Set());
      modelsByProvider.get(rate.provider)!.add(rate.modelId);
      if (isUnresolvedRate(rate)) unresolvedModelCount += 1;
    }
    for (const [provider, models] of modelsByProvider) {
      providers[provider] = { models: models.size, entries: rates.filter((r) => r.provider === provider).length };
    }
  }
  const lastFailed = await store.latestFailedSnapshot();
  const summary = latest?.sourceSummary as { catalogHash?: unknown; asOf?: unknown } | null;
  // Snapshot history for the settings panel (spec §8.7): the 10 most recent
  // snapshots with per-snapshot rate and unresolved counts.
  const recent = await store.recentSnapshots(10);
  const recentRates = await Promise.all(recent.map((snapshot) => store.ratesForSnapshot(snapshot.id)));
  return {
    latestValidSnapshot: latest
      ? {
          id: latest.id,
          createdAt: latest.createdAt,
          sourceHash: typeof summary?.catalogHash === "string" ? summary.catalogHash : null,
          asOf: typeof summary?.asOf === "string" ? summary.asOf : null,
        }
      : null,
    providers,
    unresolvedModelCount,
    lastFailedSync: lastFailed ? { id: lastFailed.id, createdAt: lastFailed.createdAt, errorSummary: lastFailed.errorSummary } : null,
    recentSnapshots: recent.map((snapshot, index) => ({
      id: snapshot.id,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      completedAt: snapshot.completedAt,
      rateCount: recentRates[index].length,
      unresolvedCount: recentRates[index].filter(isUnresolvedRate).length,
    })),
  };
}

export async function getSnapshot(
  store: PricingStore,
  id: string
): Promise<{ snapshot: PricingSnapshotRecord; rates: PricingRateRecord[] } | null> {
  const snapshot = await store.snapshotById(id);
  if (!snapshot) return null;
  return { snapshot, rates: await store.ratesForSnapshot(snapshot.id) };
}
