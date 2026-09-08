import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TrackSpec } from "../../core/config/schema.js";
import type { MetricSpec } from "../../core/contracts/evaluation.js";
import type { RenderedPayload } from "../../core/pipeline/render.js";
import { buildEvidenceJudgeSchema } from "../../core/judge/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../../");
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const firstTextBlock = (source: string) => source.match(/```text\n([\s\S]*?)```/)?.[1] ?? source;

function metricRows(source: string): MetricSpec[] {
  return [...source.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm)].map((match) => ({
    key: match[1],
    gate: /HARD/i.test(`${match[2]} ${match[3]}`) ? "hard" : "soft",
    class: /factual/i.test(match[2]) ? "factual" : /structural/i.test(match[2]) ? "structural" : "quality",
  }));
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

export async function loadNumerologyPrompt(track: TrackSpec, payload: RenderedPayload): Promise<JudgePromptBundle> {
  const kernelSource = await readFile(path.join(ROOT, "docs/LLM PLAN/01-judge-prompt/00-universal-kernel.md"), "utf8");
  const universalSource = await readFile(path.join(ROOT, "docs/LLM PLAN/02-metric-suite/00-universal-metrics.md"), "utf8");
  const rubricSource = await readFile(path.join(ROOT, "docs/LLM PLAN/01-judge-prompt/rubric-packs/numerology.md"), "utf8");
  const metrics = [...metricRows(universalSource), ...metricRows(rubricSource)];
  const schema = buildEvidenceJudgeSchema(metrics);
  const caseTemplate = kernelSource.match(/## `CASE_PAYLOAD`[\s\S]*?```text\n([\s\S]*?)```/)?.[1] ?? "";
  const referenceText = payload.content.sections.filter((section) => section.path === "silver" || section.path.startsWith("silver.")).map((section) => section.text).join("\n") || undefined;
  const userPrompt = replace(caseTemplate, {
    track_label: track.label,
    track_purpose_oneline: track.purpose,
    input_snapshot_rendered: payload.content.sections.filter((section) => section.path === "input" || section.path.startsWith("input.")).map((section) => `${section.path}: ${section.text}`).join("\n"),
    candidate_output_rendered: candidateText(payload),
    silver_output_rendered: referenceText ?? "(not supplied)",
    rubric_metric_list: metrics.map((metric) => `${metric.key}${metric.gate === "hard" ? " [HARD GATE]" : ""}`).join("\n"),
  });
  const systemPrompt = [firstTextBlock(kernelSource), firstTextBlock(universalSource), firstTextBlock(rubricSource)].join("\n\n");
  return { systemPrompt, userPrompt, jsonSchema: schema, metrics, kernelHash: sha256(kernelSource), rubricPackHash: sha256(rubricSource), schemaHash: sha256(JSON.stringify(schema)), candidateText: candidateText(payload), referenceText };
}
