// Stage 1 of the pipeline ("materialize") — docs/LLM PLAN/03-build-plan/
// 00-architecture-and-parametrization.md#pipeline-stages. Reads candidate rows
// already in this service's own DB and writes rows.jsonl. No rendering, no judge
// call: the Renderer port isn't needed until stage 2, so it isn't built yet.
//
// Only one arm exists in the imported data today (the observed model identity remains
// provisional until the champion blocker closes), so blinding here is intentionally
// single-arm: modelRef is always "arm-0" and the sealed map is written separately.
import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool } from "../../db.js";
import { isBlocked, loadBlockers, loadRunConfig, loadTrackSpecs } from "../../core/config/loader.js";
import type { Row } from "../../core/contracts/rendered-content.js";
import { materializeRows, rowsJsonl } from "../../core/pipeline/materialize.js";
import { cosmicGuidanceDatasource } from "./datasource.js";
import { persistPhase0Artifacts } from "./artifact-store.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../../config");
const MODEL_REF = "arm-0";
const OBSERVED_MODEL = "gpt-5.6-sol"; // see datasource.ts CANDIDATE_MODEL

export { loadStatusOf, rowId } from "../../core/pipeline/materialize.js";

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, file);
}

async function writeSealedMap(file: string, contents: string): Promise<void> {
  try {
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(file, "utf8");
    try {
      if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(JSON.parse(contents))) {
        throw new Error(`sealed model map already exists with different contents: ${file}`);
      }
    } catch (parseError) {
      if (parseError instanceof SyntaxError) throw new Error(`sealed model map is not valid JSON: ${file}`);
      throw parseError;
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// `users` is overridable so tests/dry-runs can scope to a handful of actors instead
// of the full ~100 — several tracks take real minutes at full scale (see track-map.ts).
export async function materialize(runId: string, users?: string[]) {
  const blockers = loadBlockers(CONFIG_DIR);
  const tracks = loadTrackSpecs(CONFIG_DIR, blockers).filter((t) => t.status === "active");
  const provenance = {
    championModelConfirmed: !isBlocked("models.champion", blockers),
    productionCorpusConfirmed: !isBlocked("datasource.production-batch-corpus", blockers),
  };

  const resolvedUsers = users ?? (await cosmicGuidanceDatasource.listUsers());
  const materialized = await materializeRows(runId, cosmicGuidanceDatasource, tracks, MODEL_REF, resolvedUsers);
  const rows: Row[] = materialized.rows.map((row) => ({ ...row, provenance }));
  const coverage = materialized.coverage;
  const perTrackCounts: Record<string, number> = Object.fromEntries(coverage.map((entry) => [entry.track, entry.actual]));

  const outDir = path.resolve(import.meta.dirname, "../../../runs", runId);
  await mkdir(outDir, { recursive: true });
  const rowsText = rowsJsonl(rows);
  const coverageText = JSON.stringify({ runId, users: resolvedUsers.length, tracks: coverage }, null, 2) + "\n";
  const modelMapText = JSON.stringify({ [MODEL_REF]: OBSERVED_MODEL }, null, 2) + "\n";
  const runConfig = loadRunConfig(CONFIG_DIR);
  const manifest = {
    version: 1,
    runId,
    stage: "materialize" as const,
    rowCount: rows.length,
    userCount: resolvedUsers.length,
    tracks: coverage,
    artifacts: { rowsSha256: hash(rowsText), coverageSha256: hash(coverageText) },
    provenance,
  };
  await persistPhase0Artifacts(runId, rows, MODEL_REF, OBSERVED_MODEL, hash(modelMapText), {
    configSnapshot: { run: runConfig, tracks, blockers },
    promptHashes: Object.fromEntries(await Promise.all(tracks.map(async (track) => [
      track.track,
      hash(await readFile(path.resolve(import.meta.dirname, "../../../", track.prompt.rubricPack), "utf8")),
    ]))),
    gitSha: process.env.GIT_SHA ?? null,
    bootstrapSeed: runId,
    status: "materialized",
  });
  await writeAtomic(path.join(outDir, "rows.jsonl"), rowsText);
  await writeAtomic(path.join(outDir, "coverage.json"), coverageText);
  await writeSealedMap(path.join(outDir, "modelmap.sealed.json"), modelMapText);
  await writeAtomic(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return { rows, perTrackCounts, coverage, users: resolvedUsers, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = process.argv[2] ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  materialize(runId)
    .then(({ rows, perTrackCounts, users, outDir }) => {
      console.log(`Materialized ${rows.length} rows across ${Object.keys(perTrackCounts).length} tracks, ${users.length} users -> ${outDir}`);
      for (const [track, count] of Object.entries(perTrackCounts).sort()) console.log(`  ${track}: ${count}`);
    })
    .finally(() => pool.end());
}
