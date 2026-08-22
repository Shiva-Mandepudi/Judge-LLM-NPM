import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadDatasetFile, checksumCases } from "../server/services/dataset-service.js";

const DATASETS_ROOT = path.resolve(process.cwd(), "datasets");

async function main() {
  const trackDirs = await readdir(DATASETS_ROOT); // directory name == track enum value, e.g. datasets/numerology/v1/cases.jsonl
  let total = 0;
  for (const track of trackDirs) {
    const versions = await readdir(path.join(DATASETS_ROOT, track)).catch(() => []);
    for (const version of versions) {
      const cases = await loadDatasetFile(track, version);
      const checksum = checksumCases(cases);
      console.log(`OK  ${track}/${version}  ${cases.length} cases  sha256:${checksum.slice(0, 12)}`);
      total += cases.length;
    }
  }
  console.log(`\nValidated ${total} total cases across ${trackDirs.length} dataset directories.`);
}

main().catch((err) => {
  console.error("Dataset validation failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
