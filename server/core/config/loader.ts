import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type Blocker,
  type BlockersConfig,
  type DatasetsConfig,
  type ModelsConfig,
  type MetricsConfig,
  type RunConfig,
  type ThresholdsConfig,
  type TrackSpec,
  blockersConfigSchema,
  datasetsConfigSchema,
  modelsConfigSchema,
  metricsConfigSchema,
  runConfigSchema,
  thresholdsConfigSchema,
  trackSpecSchema,
} from "./schema.js";

// Fails closed: a missing file or a value that doesn't match the schema throws,
// it never falls back to a hardcoded default (docs/REBUILD-PLAN.md §0 rules #4, #8).
function loadYaml(configDir: string, file: string): unknown {
  const fullPath = path.join(configDir, file);
  return parseYaml(readFileSync(fullPath, "utf8"));
}

export function loadModelsConfig(configDir: string): ModelsConfig {
  return modelsConfigSchema.parse(loadYaml(configDir, "models.yaml"));
}

export function loadThresholdsConfig(configDir: string): ThresholdsConfig {
  return thresholdsConfigSchema.parse(loadYaml(configDir, "thresholds.yaml"));
}

export function loadMetricsConfig(configDir: string): MetricsConfig {
  return metricsConfigSchema.parse(loadYaml(configDir, "metrics.yaml"));
}

export function loadDatasetsConfig(configDir: string): DatasetsConfig {
  return datasetsConfigSchema.parse(loadYaml(configDir, "datasets.yaml"));
}

export function loadRunConfig(configDir: string): RunConfig {
  return runConfigSchema.parse(loadYaml(configDir, "run.yaml"));
}

export function loadBlockers(configDir: string): BlockersConfig {
  return blockersConfigSchema.parse(loadYaml(configDir, "blockers.yaml"));
}

// Loads every config/tracks/<track>.yaml and validates each against blockers.yaml:
// a track marked "blocked" must correspond to a real open blocker, and a track marked
// "active" must not be covered by one — catches the two ways this could silently drift.
export function loadTrackSpecs(configDir: string, blockers: BlockersConfig): TrackSpec[] {
  const tracksDir = path.join(configDir, "tracks");
  const files = readdirSync(tracksDir).filter((f) => f.endsWith(".yaml"));
  return files.map((file) => {
    const spec = trackSpecSchema.parse(parseYaml(readFileSync(path.join(tracksDir, file), "utf8")));
    const isBlocked = (() => {
      try {
        assertNotBlocked(`tracks.${spec.track}`, blockers);
        return false;
      } catch (err) {
        if (err instanceof FeatureBlockedError) return true;
        throw err;
      }
    })();
    if (isBlocked !== (spec.status === "blocked")) {
      throw new Error(
        `config/tracks/${file} says status: "${spec.status}" but blockers.yaml ${
          isBlocked ? "has an open blocker covering" : "has no open blocker covering"
        } "tracks.${spec.track}" — reconcile them.`
      );
    }
    return spec;
  });
}

// "tracks.numerology_*" matches "tracks.numerology_detailed"; "models.champion"
// matches only itself.
function matchesFeature(pattern: string, featureId: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return regex.test(featureId);
}

export class FeatureBlockedError extends Error {
  constructor(public readonly featureId: string, public readonly blocker: Blocker) {
    super(`"${featureId}" is blocked by open blocker "${blocker.id}": ${blocker.reason.trim()}`);
  }
}

function findOpenBlocker(featureId: string, blockers: BlockersConfig): Blocker | undefined {
  return blockers.blockers.find(
    (blocker) => blocker.status === "open" && blocker.blocks.some((pattern) => matchesFeature(pattern, featureId))
  );
}

// True if any open blocker in blockers.yaml covers featureId — non-throwing, for
// callers that just want to stamp a caveat (e.g. Row.provenance) rather than refuse
// to proceed. Use assertNotBlocked() when the caller must refuse.
export function isBlocked(featureId: string, blockers: BlockersConfig): boolean {
  return findOpenBlocker(featureId, blockers) !== undefined;
}

// Throws FeatureBlockedError if any open blocker in blockers.yaml covers featureId.
// Call this before activating anything tied to an unresolved §1.5 question — it is
// the machine-checkable form of "no fabricated answers to open business questions".
export function assertNotBlocked(featureId: string, blockers: BlockersConfig): void {
  const blocker = findOpenBlocker(featureId, blockers);
  if (blocker) throw new FeatureBlockedError(featureId, blocker);
}
