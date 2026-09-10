import { and, eq, inArray, like, ne } from "drizzle-orm";
import path from "node:path";
import type { Db } from "../db.js";
import {
  evalDatasetCases,
  evalDatasetOutputs,
  evalDatasetSubjects,
  evalDatasets,
  evalExperiments,
} from "../../shared/schema.js";
import { loadDatasetsConfig } from "../core/config/loader.js";
import { resolveTrack } from "../adapters/cosmic-guidance/track-map.js";

export const CANONICAL_TRACK = "cg_batch_corpus";
const CONFIG_DIR = path.resolve(import.meta.dirname, "../../config");

export async function canonicalDataset(db: Db) {
  const version = loadDatasetsConfig(CONFIG_DIR).production.corpus;
  const [dataset] = await db
    .select()
    .from(evalDatasets)
    .where(and(eq(evalDatasets.track, CANONICAL_TRACK), eq(evalDatasets.version, version)));
  if (!dataset) throw new Error(`canonical dataset ${CANONICAL_TRACK}/${version} is not registered`);

  const actors = await db
    .select({ subjectKey: evalDatasetSubjects.subjectKey })
    .from(evalDatasetSubjects)
    .where(and(eq(evalDatasetSubjects.datasetId, dataset.id), like(evalDatasetSubjects.subjectKey, "cb-actor-%")));
  if (actors.length !== 100) throw new Error(`canonical dataset must contain exactly 100 actor subjects; found ${actors.length}`);
  return { dataset, actorKeys: actors.map((actor) => actor.subjectKey).sort() };
}

export interface RunCaseSelection {
  comparison: typeof evalExperiments.$inferSelect;
  dataset: typeof evalDatasets.$inferSelect;
  requestedUsers: string[];
  requestedReadingTypes: string[];
  requestedReadingSubtypes: string[];
  cases: Array<{
    id: string;
    track: string;
    readingType: string | null;
    readingSubtype: string | null;
    inputSnapshot: unknown;
  }>;
}

async function loadRunnableCases(db: Db, datasetId: string, userKeys: string[]) {
  const rows = await db
    .select({ id: evalDatasetCases.id, track: evalDatasetCases.track, readingType: evalDatasetCases.readingType, readingSubtype: evalDatasetCases.readingSubtype, inputSnapshot: evalDatasetCases.inputSnapshot })
    .from(evalDatasetCases)
    .innerJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
    .innerJoin(evalDatasetOutputs, and(eq(evalDatasetOutputs.caseId, evalDatasetCases.id), eq(evalDatasetOutputs.datasetId, datasetId)))
    .where(and(
      eq(evalDatasetCases.datasetId, datasetId),
      ne(evalDatasetCases.track, "deterministic"),
      inArray(evalDatasetSubjects.subjectKey, userKeys),
    ));
  return rows.filter((item) => resolveTrack(item.track, item.readingType, item.readingSubtype));
}

// Resolves and validates the exact case set a comparison run would execute.
// Used both when a run is created and when a no-call pre-run cost estimate is
// computed, so the estimate can never drift from the real run selection.
export async function resolveRunCaseSelection(
  db: Db,
  input: { comparisonId: string; userKeys?: string[]; readingTypes?: string[]; readingSubtypes?: string[] },
): Promise<RunCaseSelection> {
  const [comparison] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, input.comparisonId));
  if (!comparison || comparison.track !== CANONICAL_TRACK) throw new Error("comparison not found");
  const { dataset, actorKeys } = await canonicalDataset(db);
  if (comparison.datasetId !== dataset.id) throw new Error("comparison is not attached to the canonical 100-user dataset");

  const requestedUsers = [...new Set(input.userKeys?.length ? input.userKeys : actorKeys)];
  const unknownUsers = requestedUsers.filter((key) => !actorKeys.includes(key));
  if (unknownUsers.length) throw new Error(`unknown dataset users: ${unknownUsers.join(", ")}`);

  const allCases = await loadRunnableCases(db, dataset.id, requestedUsers);
  const availableReadingTypes = [...new Set(allCases.map((item) => item.readingType ?? item.track))];
  const requestedReadingTypes = [...new Set(input.readingTypes?.length ? input.readingTypes : availableReadingTypes)];
  const unknownReadingTypes = requestedReadingTypes.filter((readingType) => !availableReadingTypes.includes(readingType));
  if (unknownReadingTypes.length) throw new Error(`dataset missing for selected users: reading type(s) not available: ${unknownReadingTypes.join(", ")}`);
  const typedCases = allCases.filter((item) => requestedReadingTypes.includes(item.readingType ?? item.track));
  const availableReadingSubtypes = [...new Set(typedCases.map((item) => item.readingSubtype).filter((value): value is "brief" | "detailed" => value === "brief" || value === "detailed"))];
  const requestedReadingSubtypes = [...new Set(input.readingSubtypes?.length ? input.readingSubtypes : availableReadingSubtypes)];
  if (input.readingSubtypes?.includes("full")) throw new Error("full is automatic for full-only reading types; select brief, detailed, or both");
  const unknownReadingSubtypes = requestedReadingSubtypes.filter((readingSubtype) => !availableReadingSubtypes.includes(readingSubtype as "brief" | "detailed"));
  if (unknownReadingSubtypes.length) throw new Error(`dataset missing for selected reading type(s): reading depth(s) not available: ${unknownReadingSubtypes.join(", ")}`);
  const fullOnlyTypes = requestedReadingTypes.filter((readingType) => {
    const typeCases = typedCases.filter((item) => (item.readingType ?? item.track) === readingType);
    return typeCases.length > 0 && !typeCases.some((item) => item.readingSubtype === "brief" || item.readingSubtype === "detailed");
  });
  const cases = allCases.filter((item) => {
    const readingType = item.readingType ?? item.track;
    if (!requestedReadingTypes.includes(readingType)) return false;
    if (fullOnlyTypes.includes(readingType)) return item.readingSubtype === "full";
    return requestedReadingSubtypes.includes(item.readingSubtype as "brief" | "detailed");
  });
  if (!cases.length) throw new Error(`dataset missing: no current reading cases match the selected users, reading types, and depths`);

  return { comparison, dataset, requestedUsers, requestedReadingTypes, requestedReadingSubtypes, cases };
}
