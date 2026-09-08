// The one place that reconciles the judge-service DB's own (track, reading_type,
// reading_subtype) labelling against the 17 TrackSpec keys in config/tracks/. Every
// other adapter file works only in TrackSpec-key terms; this is the only file that
// knows the DB's naming scheme, so a schema change here needs one edit, not 17.
//
// Deliberately a pure function, not a class/Stratifier port implementation: stratum
// falls out of the exact same reading_type lookup as the track key, so a separate
// Stratifier indirection would just be two functions doing one lookup. A track whose
// stratum needs something this DB doesn't already expose can still implement the
// Stratifier port later without changing this file's contract.
//
// Returns null for anything that can't be confidently mapped (missing depth, an
// unrecognized reading_type, or a DB track outside the 17 target tracks, e.g.
// "deterministic"/"universal_insights") — callers must quarantine null, never guess.
export type ResolvedTrack = { trackKey: string; stratum: Record<string, string> };

const DEPTH_TRACKS = new Set(["natal", "transit", "synastry", "composite", "number_compatibility", "tarot"]);

export function resolveTrack(dbTrack: string, readingType: string | null, readingSubtype: string | null): ResolvedTrack | null {
  if (DEPTH_TRACKS.has(dbTrack)) {
    if (readingSubtype !== "brief" && readingSubtype !== "detailed") return null;
    return { trackKey: `${dbTrack}_${readingSubtype}`, stratum: {} };
  }

  if (dbTrack === "zodiac_profile") {
    return readingSubtype === "full" ? { trackKey: "zodiac_profile", stratum: {} } : null;
  }

  if (dbTrack === "numerology") {
    if (readingSubtype !== "brief" && readingSubtype !== "detailed") return null;
    if (!readingType?.startsWith("numerology_")) return null;
    const numberType = readingType.slice("numerology_".length);
    return { trackKey: `numerology_${readingSubtype}`, stratum: { numberType } };
  }

  // "deterministic", "universal_insights", and anything else observed in the DB are
  // not among the 17 target tracks (docs/LLM PLAN/README.md#scope-the-17-tracks) —
  // not a mapping gap, just out of scope.
  return null;
}

// The reverse direction, used to SCOPE a query to one TrackSpec key instead of
// pulling every track's rows to resolve them in memory. This matters here for a
// reason that has nothing to do with elegance: several DB tracks (synastry, transit,
// natal, composite, zodiac_profile) store ~400-500KB of chart/ephemeris JSON per row
// (verified against JUDGE_DATABASE_URL, docs/REBUILD-PLAN.md §8). Pulling all ~900 of
// those rows in one query takes 20+ minutes of server-side TOAST decompression; one
// track's ~100-200 rows takes a couple of minutes at most. `test/unit/track-map.test.ts`
// asserts every active config/tracks/*.yaml key is either listed here or in
// TRACKS_WITH_NO_DB_DATA, so this can't silently drift from resolveTrack() above.
export type DbFilter = { dbTrack: string; readingSubtype?: string };

export const TRACK_KEY_TO_DB_FILTER: Record<string, DbFilter> = {
  natal_brief: { dbTrack: "natal", readingSubtype: "brief" },
  natal_detailed: { dbTrack: "natal", readingSubtype: "detailed" },
  transit_brief: { dbTrack: "transit", readingSubtype: "brief" },
  transit_detailed: { dbTrack: "transit", readingSubtype: "detailed" },
  synastry_brief: { dbTrack: "synastry", readingSubtype: "brief" },
  synastry_detailed: { dbTrack: "synastry", readingSubtype: "detailed" },
  composite_brief: { dbTrack: "composite", readingSubtype: "brief" },
  composite_detailed: { dbTrack: "composite", readingSubtype: "detailed" },
  number_compatibility_brief: { dbTrack: "number_compatibility", readingSubtype: "brief" },
  number_compatibility_detailed: { dbTrack: "number_compatibility", readingSubtype: "detailed" },
  tarot_brief: { dbTrack: "tarot", readingSubtype: "brief" },
  tarot_detailed: { dbTrack: "tarot", readingSubtype: "detailed" },
  zodiac_profile: { dbTrack: "zodiac_profile", readingSubtype: "full" },
  numerology_brief: { dbTrack: "numerology", readingSubtype: "brief" },
  numerology_detailed: { dbTrack: "numerology", readingSubtype: "detailed" },
};

// TrackSpec keys confirmed (2026-09-08, against JUDGE_DATABASE_URL) to have zero rows
// in this DB under any db_track value — not a mapping gap, there is simply no
// candidate data yet for these two tracks.
export const TRACKS_WITH_NO_DB_DATA = new Set(["my_day", "static_scores"]);
