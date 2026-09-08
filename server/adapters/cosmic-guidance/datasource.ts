// Reads candidate readings already materialized into THIS service's own Postgres DB
// (eval_dataset_cases / eval_jobs / eval_generations) — not a live CosmicGuidance
// connection (docs/REBUILD-PLAN.md §0 rule #7: CG's DB is never queried directly).
//
// Queries are scoped per TrackSpec key (via TRACK_KEY_TO_DB_FILTER), never "fetch
// everything and filter in memory" — see track-map.ts for why that matters here.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Datasource, RawRow } from "../../core/contracts/ports.js";
import type { UserId } from "../../core/contracts/rendered-content.js";
import { db } from "../../db.js";
import { evalDatasetCases, evalDatasetSubjects, evalGenerations, evalJobs } from "../../../shared/schema.js";
import { resolveTrack, TRACK_KEY_TO_DB_FILTER } from "./track-map.js";

// The champion model string as actually stored (verified against JUDGE_DATABASE_URL,
// see docs/REBUILD-PLAN.md §8 2026-09-08 entries). config/blockers.yaml
// "champion-model-confirmation" is still open — this is what's in the DB today, not
// a confirmed provider/model-ID. Other rows in eval_generations (`baseline-model-v1`,
// `candidate-model-v1`) are unrelated mock-provider test fixtures, not this corpus —
// filtering by model, not by `arm`, is what actually excludes them.
const CANDIDATE_MODEL = "gpt-5.6-sol";

export const cosmicGuidanceDatasource: Datasource = {
  // Small columns only (no jsonb) — safe to scan the whole corpus for this.
  async listUsers(): Promise<UserId[]> {
    const rows = await db
      .select({ userId: evalDatasetSubjects.subjectKey })
      .from(evalDatasetCases)
      .innerJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
      .innerJoin(evalJobs, eq(evalJobs.caseId, evalDatasetCases.id))
      .innerJoin(evalGenerations, eq(evalGenerations.jobId, evalJobs.id))
      .where(and(isNotNull(evalDatasetCases.subjectId), eq(evalGenerations.model, CANDIDATE_MODEL)));
    return [...new Set(rows.map((r) => r.userId))].sort();
  },

  // Scoped to exactly one TrackSpec key's db_track(+reading_subtype) and the
  // requested users — bounds each query to ~100-200 rows even for the tracks with
  // large chart/ephemeris payloads.
  async fetchRows(track: string, users: UserId[]): Promise<RawRow[]> {
    const filter = TRACK_KEY_TO_DB_FILTER[track];
    if (!filter || users.length === 0) return []; // e.g. my_day/static_scores — no DB data, not an error

    const conditions = [
      isNotNull(evalDatasetCases.subjectId),
      eq(evalGenerations.model, CANDIDATE_MODEL),
      eq(evalDatasetCases.track, filter.dbTrack),
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
        parsedOutput: evalGenerations.parsedOutput,
        schemaValid: evalGenerations.schemaValid,
        tokensPrompt: evalGenerations.tokensPrompt,
        tokensCompletion: evalGenerations.tokensCompletion,
        latencyMs: evalGenerations.latencyMs,
      })
      .from(evalDatasetCases)
      .innerJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
      .innerJoin(evalJobs, eq(evalJobs.caseId, evalDatasetCases.id))
      .innerJoin(evalGenerations, eq(evalGenerations.jobId, evalJobs.id))
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
          inputTokens: row.tokensPrompt ?? 0,
          outputTokens: row.tokensCompletion ?? 0,
          latencyMs: row.latencyMs ?? 0,
        },
      });
    }
    return out;
  },
};
