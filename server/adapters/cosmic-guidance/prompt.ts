import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TrackSpec } from "../../core/config/schema.js";
import type { MetricSpec } from "../../core/contracts/evaluation.js";
import type { RenderedPayload } from "../../core/pipeline/render.js";
import { buildEvidenceJudgeSchema } from "../../core/judge/schema.js";
import { loadBlockers, loadTrackSpecs } from "../../core/config/loader.js";

const ROOT = path.resolve(import.meta.dirname, "../../../");
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const firstTextBlock = (source: string) => source.match(/```text\n([\s\S]*?)```/)?.[1] ?? source;

function metricRows(source: string): MetricSpec[] {
  return [...source.matchAll(/^\|\s*`([^`]+)`\s*\|([^\n]+)$/gm)].map((match) => {
    const columns = match[2].split("|").map((column) => column.trim());
    const classification = columns.join(" ");
    return {
      key: match[1],
      gate: /HARD/i.test(classification) ? "hard" : "soft",
      class: /comparative/i.test(classification) ? "comparative" : /factual/i.test(classification) ? "factual" : /structural/i.test(classification) ? "structural" : "quality",
    };
  });
}

function replace(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
}

function candidateText(payload: RenderedPayload): string {
  return payload.content.sections.filter((section) => section.path === "candidate" || section.path.startsWith("candidate.")).map((section) => section.text).join("\n");
}

export type JudgePromptBundle = {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  metrics: MetricSpec[];
  kernelHash: string;
  rubricPackHash: string;
  schemaHash: string;
  candidateText: string;
  referenceText?: string;
};

export async function loadTrackPrompt(track: TrackSpec, payload: RenderedPayload): Promise<JudgePromptBundle> {
  if (payload.track !== track.track) {
    throw new Error(`prompt/track mismatch: payload is "${payload.track}" but config is "${track.track}"`);
  }
  const kernelSource = await readFile(path.join(ROOT, "docs/LLM PLAN/01-judge-prompt/00-universal-kernel.md"), "utf8");
  const universalSource = await readFile(path.join(ROOT, "docs/LLM PLAN/02-metric-suite/00-universal-metrics.md"), "utf8");
  const rubricSource = await readFile(path.resolve(ROOT, track.prompt.rubricPack), "utf8");
  const referenceText = payload.content.sections.filter((section) => section.path === "silver" || section.path.startsWith("silver.")).map((section) => section.text).join("\n") || undefined;
  const metrics = [...metricRows(universalSource), ...metricRows(rubricSource)].filter((metric, index, all) => all.findIndex((candidate) => candidate.key === metric.key) === index).filter((metric) => metric.class !== "comparative" || Boolean(referenceText));
  const schema = buildEvidenceJudgeSchema(metrics);
  const caseTemplate = kernelSource.match(/## `CASE_PAYLOAD`[\s\S]*?```text\n([\s\S]*?)```/)?.[1] ?? "";
  const userPrompt = replace(caseTemplate, {
    track_label: track.label,
    track_purpose_oneline: track.purpose,
    depth: track.depth ?? "",
    input_snapshot_rendered: payload.content.sections.filter((section) => section.path === "input" || section.path.startsWith("input.")).map((section) => `${section.path}: ${section.text}`).join("\n"),
    candidate_output_rendered: candidateText(payload),
    silver_output_rendered: referenceText ?? "(not supplied)",
    rubric_metric_list: metrics.map((metric) => `${metric.key}${metric.gate === "hard" ? " [HARD GATE]" : ""}`).join("\n"),
  });
  const systemPrompt = [firstTextBlock(kernelSource), firstTextBlock(universalSource), firstTextBlock(rubricSource)].join("\n\n");
  return { systemPrompt, userPrompt, jsonSchema: schema, metrics, kernelHash: sha256(kernelSource), rubricPackHash: sha256(rubricSource), schemaHash: sha256(JSON.stringify(schema)), candidateText: candidateText(payload), referenceText };
}

/** Resolve the prompt from the canonical track registry; callers cannot select a rubric by guesswork. */
export async function loadConfiguredTrackPrompt(trackKey: string, payload: RenderedPayload): Promise<JudgePromptBundle> {
  const configDir = path.join(ROOT, "config");
  const track = loadTrackSpecs(configDir, loadBlockers(configDir)).find((candidate) => candidate.track === trackKey);
  if (!track) throw new Error(`unknown configured reading track "${trackKey}"`);
  if (track.status !== "active") throw new Error(`reading track "${trackKey}" is blocked and cannot be judged`);
  return loadTrackPrompt(track, payload);
}

/** Backward-compatible name for the Phase 1 vertical slice. */
export const loadNumerologyPrompt = loadTrackPrompt;
