import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db, pool } from "../server/db.js";
import { evalComparisonRuns, evalDatasetOutputs, evalGenerations, evalJobs, evalPricingRates } from "../shared/schema.js";
import { createDrizzlePricingStore, getLatestValidSnapshot, syncOfficialPrices } from "../server/services/pricing-service.js";
import { estimateRunCost, getRunCostAnalysis, type RunCostAnalysis } from "../server/services/cost-service.js";
import { canonicalDataset } from "../server/services/run-case-selection.js";

// Phase E live validation (docs/COST-ANALYSIS-E2E-PLAN.md §12-14). Read-only on
// eval data — the ONLY writes are the pricing snapshot syncs in step A. Prints
// ids, counts, statuses, and costs only; never connection strings or secrets.
// Exits non-zero if any check FAILs.

const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

function missing(label: string) {
  console.log(`MISSING: ${label}`);
  failures.push(label);
}

// Rollups are rounded to 6 decimals at the response boundary, so a sum of N
// rounded groups can drift from the rounded total by at most (N+1) * 5e-7.
const rollupTolerance = (parts: number) => Math.max(1e-6, 5e-7 * (parts + 1));

const money = (value: number | null) => (value === null ? "unknown" : `$${value}`);

async function datasetOutputsCount(): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(evalDatasetOutputs);
  return rows[0]?.count ?? 0;
}

function reconcile(analysis: RunCostAnalysis, baselineGenerationRows: number) {
  const { summary } = analysis;
  const total = summary.total.costUsd;
  console.log(
    `  summary: candidate=${money(summary.candidate.costUsd)} (${summary.candidate.status}) · primaryJudge=${money(summary.primaryJudge.costUsd)} (${summary.primaryJudge.status}) · secondaryJudge=${money(summary.secondaryJudge.costUsd)} (${summary.secondaryJudge.status}) · total=${money(total)} (${summary.total.status})`,
  );
  console.log(`  unknownCostRate=${analysis.unknownCostRate ?? "n/a"} · missingUsageRate=${analysis.missingUsageRate ?? "n/a"} · warnings=${analysis.warnings.length}`);

  const components = [summary.candidate.costUsd, summary.primaryJudge.costUsd, summary.secondaryJudge.costUsd].filter(
    (value): value is number => value != null,
  );
  if (total == null) {
    check("components reconcile with total", components.length === 0, "total unknown and every component unknown");
  } else {
    const sum = components.reduce((acc, value) => acc + value, 0);
    const diff = Math.abs(sum - total);
    check("components reconcile with total", diff <= rollupTolerance(components.length), `candidate+primary+secondary=${sum} vs total=${total} (diff ${diff.toExponential(2)})`);
  }

  const userCosts = analysis.byUser.map((user) => user.totalKnownCostUsd).filter((value): value is number => value != null);
  if (total == null) {
    check("byUser totals reconcile with total", userCosts.length === 0, "total unknown and no priced user rollups");
  } else {
    const sum = userCosts.reduce((acc, value) => acc + value, 0);
    const diff = Math.abs(sum - total);
    check("byUser totals reconcile with total", diff <= rollupTolerance(userCosts.length), `${userCosts.length} users sum=${sum} vs total=${total} (diff ${diff.toExponential(2)})`);
  }

  const readingCosts = analysis.byReading.map((reading) => reading.costUsd).filter((value): value is number => value != null);
  if (total == null) {
    check("byReading totals reconcile with total", readingCosts.length === 0, "total unknown and no priced reading rollups");
  } else {
    const sum = readingCosts.reduce((acc, value) => acc + value, 0);
    const diff = Math.abs(sum - total);
    check("byReading totals reconcile with total", diff <= rollupTolerance(readingCosts.length), `${readingCosts.length} readings sum=${sum} vs total=${total} (diff ${diff.toExponential(2)})`);
  }

  check(
    "baseline-arm rows contribute zero",
    analysis.provenance.baselineRowsExcluded === baselineGenerationRows,
    `${analysis.provenance.baselineRowsExcluded} baseline row(s) excluded from every rollup; component sums above still equal the total`,
  );
}

async function main() {
  const store = createDrizzlePricingStore(db);
  const outputsBefore = await datasetOutputsCount();
  console.log(`eval_dataset_outputs rows before validation: ${outputsBefore}`);

  // --- A. Pricing sync, twice (idempotency) -------------------------------
  console.log("\n[A] Pricing sync (triggered_by phase-e-validation, drift check on)");
  const configDir = path.resolve(process.cwd(), "config");
  const rawCatalog = parseYaml(readFileSync(path.join(configDir, "pricing-catalog.yaml"), "utf8"));

  const first = await syncOfficialPrices(store, { rawCatalog, triggeredBy: "phase-e-validation", checkDrift: true });
  if (first.status === "failed") {
    check("first pricing sync", false, first.errors.join(" | "));
    throw new Error("pricing sync failed; cannot continue cost validation");
  }
  console.log(`  sync #1: status=${first.status} snapshot=${first.snapshotId} counts=${JSON.stringify(first.counts)}`);
  for (const [provider, drift] of Object.entries(first.providers)) {
    console.log(`  provider ${provider}: ${drift.reachable ? `reachable (HTTP ${drift.httpStatus})` : `UNREACHABLE (${drift.error ?? `HTTP ${drift.httpStatus}`})`}`);
  }
  const latestAfterFirst = await getLatestValidSnapshot(store);
  const ratesAfterFirst = (
    await db.select({ count: sql<number>`count(*)::int` }).from(evalPricingRates).where(eq(evalPricingRates.snapshotId, latestAfterFirst!.id))
  )[0].count;

  const second = await syncOfficialPrices(store, { rawCatalog, triggeredBy: "phase-e-validation", checkDrift: true });
  console.log(`  sync #2: status=${second.status}${second.status !== "failed" ? ` snapshot=${second.snapshotId} counts=${JSON.stringify(second.counts)}` : ""}`);
  check(
    "second sync is idempotent",
    second.status === "unchanged" && second.snapshotId === latestAfterFirst?.id,
    second.status === "failed" ? second.errors.join(" | ") : `status=${second.status}, same snapshot=${second.snapshotId === latestAfterFirst?.id}`,
  );
  if (second.status !== "failed") {
    const ratesAfterSecond = (
      await db.select({ count: sql<number>`count(*)::int` }).from(evalPricingRates).where(eq(evalPricingRates.snapshotId, second.snapshotId))
    )[0].count;
    check("idempotent sync wrote no duplicate rates", ratesAfterSecond === ratesAfterFirst, `${ratesAfterFirst} rates before, ${ratesAfterSecond} after`);
  }

  // --- B. Cost analysis of a completed and a failed/cancelled run ---------
  console.log("\n[B] Run cost analysis");
  const [completedRun] = await db
    .select()
    .from(evalComparisonRuns)
    .where(eq(evalComparisonRuns.status, "completed"))
    .orderBy(desc(evalComparisonRuns.createdAt))
    .limit(1);
  const [failedRun] = await db
    .select()
    .from(evalComparisonRuns)
    .where(inArray(evalComparisonRuns.status, ["failed", "cancelled"]))
    .orderBy(desc(evalComparisonRuns.createdAt))
    .limit(1);

  let completedAnalysis: RunCostAnalysis | null = null;
  if (!completedRun) {
    missing("no completed comparison run in the dev database");
  } else {
    completedAnalysis = await getRunCostAnalysis(db, completedRun.id);
    console.log(`  completed run ${completedRun.id}:`);
    console.log(`    status=${completedAnalysis.status} · pricing.snapshotId=${completedAnalysis.pricing.snapshotId ?? "none"}`);
    const baselineRows = await countBaselineRows(completedRun.id);
    reconcile(completedAnalysis, baselineRows);
  }

  if (!failedRun) {
    console.log("  note: no failed-or-cancelled comparison run exists in the dev database (nothing to validate there)");
  } else {
    const analysis = await getRunCostAnalysis(db, failedRun.id);
    console.log(`  ${failedRun.status} run ${failedRun.id}:`);
    console.log(`    status=${analysis.status} · pricing.snapshotId=${analysis.pricing.snapshotId ?? "none"}`);
    const jobRows = await db.select({ status: evalJobs.status }).from(evalJobs).where(eq(evalJobs.runId, failedRun.id));
    const finishedJobs = jobRows.filter((job) => job.status === "completed" || job.status === "failed").length;
    const baselineRows = await countBaselineRows(failedRun.id);
    reconcile(analysis, baselineRows);
    if (finishedJobs === 0) {
      check("failed/cancelled run cost exposure", analysis.status === "unknown", `zero finished jobs -> status 'unknown' (no observed usage to price)`);
    } else if (analysis.summary.total.costUsd != null) {
      check("failed/cancelled run cost exposure", true, `observed cost from ${finishedJobs} finished job(s) is exposed (total=${money(analysis.summary.total.costUsd)})`);
    } else {
      // Observed usage exists but none of it is priceable (usage captured
      // before Phase A, or models absent from the catalog): the service must
      // still expose the run and mark every cost unknown with a reason — never $0.
      const unknownsHaveReasons = analysis.unknownCostRate === 1;
      const notesRunState = analysis.warnings.some((warning) => warning.includes(failedRun.status));
      check(
        "failed/cancelled run cost exposure",
        analysis.status === "unknown" && unknownsHaveReasons && notesRunState,
        `${finishedJobs} finished job(s) observed but no priceable usage — correctly reported unknown (never $0), warnings=${analysis.warnings.length}`,
      );
    }
  }

  // --- C. Historical immutability ------------------------------------------
  console.log("\n[C] Historical snapshot immutability");
  const [linkedRun] = await db
    .select()
    .from(evalComparisonRuns)
    .where(isNotNull(evalComparisonRuns.pricingSnapshotId))
    .orderBy(desc(evalComparisonRuns.createdAt))
    .limit(1);
  if (!linkedRun?.pricingSnapshotId) {
    console.log("  SKIP: no run has a recorded pricing snapshot yet (runs predate migration 0011)");
  } else {
    const analysis = await getRunCostAnalysis(db, linkedRun.id);
    const latest = await getLatestValidSnapshot(store);
    check(
      "run is priced with its recorded snapshot, not the latest",
      analysis.pricing.snapshotId === linkedRun.pricingSnapshotId,
      `run snapshot=${linkedRun.pricingSnapshotId} · analysis snapshot=${analysis.pricing.snapshotId} · latest valid=${latest?.id ?? "none"}${latest && latest.id !== linkedRun.pricingSnapshotId ? " (differs — immutability proven)" : " (only snapshot so far)"}`,
    );
  }

  // --- D. Pre-run estimate ---------------------------------------------------
  console.log("\n[D] Pre-run estimate (zero network calls by construction — buildRunEstimate has no fetch)");
  if (!completedRun) {
    missing("no completed run to estimate against");
  } else {
    const estimate = await estimateRunCost(db, { comparisonId: completedRun.comparisonId });
    console.log(`  cases=${estimate.cases} · pricedWith.snapshotId=${estimate.pricedWith.snapshotId ?? "none"} · assumptions=${estimate.assumptions.length}`);
    console.log(
      `  candidate=${money(estimate.estimate.candidate.costUsd)} (${estimate.estimate.candidate.status}) · primaryJudge=${money(estimate.estimate.primaryJudge.costUsd)} (${estimate.estimate.primaryJudge.status}) · secondaryJudge=${money(estimate.estimate.secondaryJudge.costUsd)} (${estimate.estimate.secondaryJudge.status}) · total=${money(estimate.estimate.total.costUsd)} (${estimate.estimate.total.status})`,
    );
    check("estimate resolves the comparison case set", estimate.cases > 0, `${estimate.cases} case(s)`);
  }

  // --- E. Dataset integrity --------------------------------------------------
  console.log("\n[E] Dataset integrity");
  try {
    const { dataset, actorKeys } = await canonicalDataset(db);
    check("canonical cg_batch_corpus dataset has exactly 100 subjects", actorKeys.length === 100, `dataset ${dataset.id}, ${actorKeys.length} actor subjects`);
  } catch (error) {
    check("canonical cg_batch_corpus dataset has exactly 100 subjects", false, error instanceof Error ? error.message : String(error));
  }
  const outputsAfter = await datasetOutputsCount();
  check("eval_dataset_outputs unchanged by validation", outputsAfter === outputsBefore, `${outputsBefore} before, ${outputsAfter} after (only pricing snapshots were written)`);

  console.log(failures.length ? `\nRESULT: FAIL (${failures.length} check(s) failed)` : "\nRESULT: ALL CHECKS PASSED");
  if (failures.length) process.exitCode = 1;
}

async function countBaselineRows(runId: string): Promise<number> {
  const jobIds = (await db.select({ id: evalJobs.id }).from(evalJobs).where(eq(evalJobs.runId, runId))).map((job) => job.id);
  if (!jobIds.length) return 0;
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(evalGenerations)
    .where(and(inArray(evalGenerations.jobId, jobIds), ne(evalGenerations.arm, "candidate")));
  return rows[0].count;
}

main()
  .catch((error) => {
    console.error(`VALIDATION ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
