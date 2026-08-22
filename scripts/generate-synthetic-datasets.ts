/**
 * Refreshes a dataset by fetching deterministic calculation outputs from
 * Cosmic Guidance's internal evaluation-generation interface
 * (POST /api/internal/judge/calc-snapshot — same auth as generation calls),
 * for a list of synthetic subject definitions. This script NEVER computes
 * astrology/numerology values itself — it only supplies subject parameters
 * (e.g. "life_path=11", a birth-data-shaped synthetic profile) and records
 * whatever Cosmic Guidance's own calculators return.
 *
 * Usage: tsx scripts/generate-synthetic-datasets.ts --track numerology --version v2 --subjects subjects.json
 */
import { writeFile } from "node:fs/promises";
import { datasetFilePath } from "../server/services/dataset-service.js";
import type { DatasetCase } from "../shared/dataset-types.js";

interface SubjectDef {
  caseKey: string;
  promptVersion: string;
  calcInputs: Record<string, unknown>;
  tags?: string[];
}

async function fetchCalcSnapshot(baseUrl: string, sharedSecret: string, calcInputs: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/internal/judge/calc-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-judge-shared-secret": sharedSecret },
    body: JSON.stringify({ calcInputs }),
  });
  if (!res.ok) throw new Error(`calc-snapshot request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { inputSnapshot: Record<string, unknown> };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const track = flag("track");
  const version = flag("version");
  const subjectsPath = flag("subjects");
  if (!track || !version || !subjectsPath) {
    console.error("Usage: tsx scripts/generate-synthetic-datasets.ts --track <track> --version <version> --subjects <subjects.json>");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.COSMIC_GUIDANCE_INTERNAL_BASE_URL;
  const sharedSecret = process.env.JUDGE_TO_CG_SHARED_SECRET;
  if (!baseUrl || !sharedSecret) {
    throw new Error(
      "COSMIC_GUIDANCE_INTERNAL_BASE_URL and JUDGE_TO_CG_SHARED_SECRET must be set — this script sources every " +
      "calculated value from Cosmic Guidance's own calculators and refuses to invent them locally.",
    );
  }

  const { readFile } = await import("node:fs/promises");
  const subjects: SubjectDef[] = JSON.parse(await readFile(subjectsPath, "utf8"));

  const lines: string[] = [];
  for (const subject of subjects) {
    const { inputSnapshot } = await fetchCalcSnapshot(baseUrl, sharedSecret, subject.calcInputs);
    const record: DatasetCase = {
      caseKey: subject.caseKey,
      track: track as DatasetCase["track"],
      promptVersion: subject.promptVersion,
      inputSnapshot,
      tags: subject.tags ?? [],
      calcSource: "cosmic_guidance_internal_api",
    };
    lines.push(JSON.stringify(record));
  }

  const outPath = datasetFilePath(track, version);
  await writeFile(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${lines.length} cases to ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
