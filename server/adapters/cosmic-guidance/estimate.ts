import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadModelsConfig } from "../../core/config/loader.js";
import { estimatePayloads } from "../../core/pipeline/estimate.js";
import type { Row } from "../../core/contracts/rendered-content.js";
import { renderRun } from "./render.js";
import { materialize } from "./materialize.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../../config");

export async function estimate(runId: string, rows?: Row[]) {
  const materialized = rows ?? (await materialize(runId)).rows;
  const { payloads } = await renderRun(runId, materialized);
  return estimatePayloads(payloads, loadModelsConfig(CONFIG_DIR));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = process.argv[2] ?? `estimate-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  estimate(runId).then((result) => {
    console.log(JSON.stringify({ runId, ...result }, null, 2));
  });
}
