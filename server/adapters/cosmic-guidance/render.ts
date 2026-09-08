import "dotenv/config";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderRows, type RenderedPayload } from "../../core/pipeline/render.js";
import type { Row } from "../../core/contracts/rendered-content.js";
import { loadBlockers, loadTrackSpecs } from "../../core/config/loader.js";
import { rendererRegistry } from "./renderer.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../../config");

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, file);
}

export async function renderRun(runId: string, rows?: Row[]): Promise<{ payloads: RenderedPayload[]; outDir: string }> {
  const outDir = path.resolve(import.meta.dirname, "../../../runs", runId);
  const materialized = rows ?? (await readFile(path.join(outDir, "rows.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  const tracks = loadTrackSpecs(CONFIG_DIR, loadBlockers(CONFIG_DIR)).filter((track) => track.status === "active");
  const payloads = renderRows(materialized, rendererRegistry(tracks));
  const payloadText = payloads.map((payload) => JSON.stringify(payload)).join("\n") + (payloads.length ? "\n" : "");
  await writeAtomic(path.join(outDir, "payloads.jsonl"), payloadText);
  await writeAtomic(path.join(outDir, "render-manifest.json"), JSON.stringify({
    version: 1,
    runId,
    stage: "render",
    inputRows: materialized.length,
    renderedRows: payloads.length,
    skippedRows: materialized.length - payloads.length,
  }, null, 2) + "\n");
  return { payloads, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = process.argv[2];
  if (!runId) throw new Error("usage: npm run render:cosmic-guidance -- <runId>");
  renderRun(runId).then(({ payloads, outDir }) => {
    console.log(`Rendered ${payloads.length} blinded payloads -> ${outDir}`);
  });
}
