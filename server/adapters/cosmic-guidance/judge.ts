import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderBinding } from "../../../shared/config-schema.js";
import type { RenderedPayload } from "../../core/pipeline/render.js";
import { assertNotBlocked, loadBlockers, loadDatasetsConfig, loadTrackSpecs } from "../../core/config/loader.js";
import { judgeAndPersistRenderedPayload } from "./evidence-judge.js";
import { loadTrackPrompt } from "./prompt.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../../config");

/** Runs the rebuilt evidence judge and selects each rubric from that payload's configured track. */
export async function judgeRun(runId: string, binding: ProviderBinding, judgeEffort: string): Promise<{ runId: string; judged: number; statuses: Record<string, number> }> {
  const outDir = path.resolve(import.meta.dirname, "../../../runs", runId);
  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8")) as { runId?: string; stage?: string; dataset?: { source: string; corpus: string; candidateModel: string; confirmed: boolean } };
  const dataset = loadDatasetsConfig(CONFIG_DIR).production;
  if (manifest.runId !== runId || manifest.stage !== "materialize") throw new Error(`run ${runId} has no valid materialize manifest`);
  if (!manifest.dataset || manifest.dataset.source !== dataset.source || manifest.dataset.corpus !== dataset.corpus || manifest.dataset.candidateModel !== dataset.candidateModel) {
    throw new Error(`run ${runId} dataset manifest does not match the current production dataset registry`);
  }
  if (!dataset.confirmed) throw new Error(`dataset corpus "${dataset.corpus}" is not confirmed for live judging`);
  assertNotBlocked("datasource.production-batch-corpus", loadBlockers(CONFIG_DIR));
  const payloads = (await readFile(path.join(outDir, "payloads.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as RenderedPayload);
  const tracks = loadTrackSpecs(CONFIG_DIR, loadBlockers(CONFIG_DIR)).filter((track) => track.status === "active");
  const byTrack = new Map(tracks.map((track) => [track.track, track]));
  const statuses: Record<string, number> = {};
  for (const payload of payloads) {
    const track = byTrack.get(payload.track);
    if (!track) throw new Error(`payload track "${payload.track}" is not an active configured reading`);
    const prompt = await loadTrackPrompt(track, payload);
    const result = await judgeAndPersistRenderedPayload(payload, prompt, binding, judgeEffort);
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  }
  return { runId, judged: payloads.length, statuses };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runId, provider = process.env.JUDGE_PROVIDER, model = process.env.JUDGE_MODEL, secretRef = process.env.JUDGE_SECRET_REF, judgeEffort = process.env.JUDGE_EFFORT ?? "high"] = process.argv.slice(2);
  if (!runId || !provider || !model || !secretRef) throw new Error("usage: npm run judge:cosmic-guidance -- <runId> [provider model secretRef judgeEffort]");
  judgeRun(runId, { provider, model, secretRef }, judgeEffort).then((result) => console.log(JSON.stringify(result, null, 2)));
}
