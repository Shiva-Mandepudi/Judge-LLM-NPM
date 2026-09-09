// Reads current readings already materialized into THIS service's own Postgres DB
// (eval_dataset_cases / eval_dataset_outputs) — not a live CosmicGuidance
// connection (docs/REBUILD-PLAN.md §0 rule #7: CG's DB is never queried directly).
//
// Queries are scoped per TrackSpec key (via TRACK_KEY_TO_DB_FILTER), never "fetch
// everything and filter in memory" — see track-map.ts for why that matters here.
import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import path from "node:path";
import type { Datasource, RawRow } from "../../core/contracts/ports.js";
import type { UserId } from "../../core/contracts/rendered-content.js";
import { db } from "../../db.js";
import { evalDatasetCases, evalDatasetOutputs, evalDatasetSubjects, evalDatasets } from "../../../shared/schema.js";
import { loadDatasetsConfig } from "../../core/config/loader.js";
import { resolveTrack, TRACK_KEY_TO_DB_FILTER, TRACKS_WITH_NO_DB_DATA } from "./track-map.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../../config");
const DATASET = loadDatasetsConfig(CONFIG_DIR).production;
const CANDIDATE_MODEL = DATASET.candidateModel;
const DATASET_DB_TRACKS = [...new Set(Object.values(TRACK_KEY_TO_DB_FILTER).map((filter) => filter.dbTrack))];

// The champion model string as actually stored (verified against JUDGE_DATABASE_URL,
// see docs/REBUILD-PLAN.md §8 2026-09-08 entries). config/blockers.yaml
// "champion-model-confirmation" is still open — this is what's in the DB today, not
// a confirmed provider/model-ID. Other rows in eval_generations (`baseline-model-v1`,
// `candidate-model-v1`) are unrelated mock-provider test fixtures, not this corpus —
// filtering by model, not by `arm`, is what actually excludes them.
export { CANDIDATE_MODEL };

export const cosmicGuidanceDatasource: Datasource = {
  // Small columns only (no jsonb) — safe to scan the whole corpus for this.
  async listUsers(): Promise<UserId[]> {
    const rows = await db
      .select({ userId: evalDatasetSubjects.subjectKey })
      .from(evalDatasetSubjects)
      .innerJoin(evalDatasets, eq(evalDatasets.id, evalDatasetSubjects.datasetId))
      .where(and(eq(evalDatasets.track, "cg_batch_corpus"), eq(evalDatasets.version, DATASET.corpus), like(evalDatasetSubjects.subjectKey, "cb-actor-%")));
    return [...new Set(rows.map((r) => r.userId))].sort();
  },

  // Scoped to exactly one TrackSpec key's db_track(+reading_subtype) and the
  // requested users — bounds each query to ~100-200 rows even for the tracks with
  // large chart/ephemeris payloads.
  async fetchRows(track: string, users: UserId[]): Promise<RawRow[]> {
    const filter = TRACK_KEY_TO_DB_FILTER[track];
    if (!filter) {
      if (TRACKS_WITH_NO_DB_DATA.has(track)) return []; // explicit no-data source: report NO RECOMMENDATION
      throw new Error(`no dataset mapping exists for configured reading track "${track}"`);
    }
    if (users.length === 0) return [];
    if (!DATASET.tracks.includes(track)) throw new Error(`dataset manifest does not include configured track "${track}"`);

    const conditions = [
      isNotNull(evalDatasetCases.subjectId),
      eq(evalDatasets.track, "cg_batch_corpus"),
      eq(evalDatasets.version, DATASET.corpus),
      eq(evalDatasetCases.track, filter.dbTrack),
      eq(evalDatasetOutputs.model, CANDIDATE_MODEL),
      inArray(evalDatasetSubjects.subjectKey, users),
    ];
    if (filter.readingSubtype) conditions.push(eq(evalDatasetCases.readingSubtype, filter.readingSubtype));

    const rows = await db
      .select({
        userId: evalDatasetSubjects.subjectKey,
        dbTrack: evalDatasetCases.track,
        readingType: evalDatasetCases.readingType,
        readingSubtype: evalDatasetCases.readingSubtype,
        inputSnapshot: evalDatasetCases.inputSnapshot,
        parsedOutput: evalDatasetOutputs.parsedOutput,
        schemaValid: evalDatasetOutputs.schemaValid,
        usage: evalDatasetOutputs.usage,
      })
      .from(evalDatasetCases)
      .innerJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
      .innerJoin(evalDatasets, eq(evalDatasets.id, evalDatasetCases.datasetId))
      .innerJoin(evalDatasetOutputs, and(eq(evalDatasetOutputs.caseId, evalDatasetCases.id), eq(evalDatasetOutputs.datasetId, evalDatasetCases.datasetId)))
      .where(and(...conditions));

    const out: RawRow[] = [];
    for (const row of rows) {
      const resolved = resolveTrack(row.dbTrack, row.readingType, row.readingSubtype);
      if (!resolved || resolved.trackKey !== track) continue; // quarantined — never guessed
      out.push({
        userId: row.userId,
        track: resolved.trackKey,
        stratum: resolved.stratum,
        inputSnapshot: row.inputSnapshot,
        candidateOutput: row.parsedOutput,
        candidateSchemaValid: row.schemaValid,
        silverOutput: null, // policy decision: no silver reference — config/blockers.yaml "numerology-silver-source"
        generation: {
          inputTokens: Number((row.usage as Record<string, unknown> | null)?.promptTokens ?? 0),
          outputTokens: Number((row.usage as Record<string, unknown> | null)?.completionTokens ?? 0),
          latencyMs: Number((row.usage as Record<string, unknown> | null)?.latencyMs ?? 0),
        },
      });
    }
    return out;
  },
};
