import type { EvalTrack } from "../../shared/schema.js";
import { dimensionsForTrack, RUBRIC_VERSION, type RubricDimension } from "../../shared/rubric.js";
import { buildJudgeSchema } from "../../shared/judge-schema.js";

export interface JudgePromptInput {
  track: EvalTrack;
  inputSnapshot: Record<string, unknown>;
  calcOutputs: Record<string, unknown> | null;
  responseA: Record<string, unknown>;
  responseB: Record<string, unknown> | null; // null for single-arm baseline-regression
}

export interface BuiltJudgePrompt {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  dimensions: RubricDimension[];
  rubricVersion: string;
  labels: string[];
}

// Template follows judge-llm-evaluation-framework.md §10 in structure:
// unlabeled shared input data, model identity stripped, and do-not-reward-length
// instruction. Judges inspect every rubric dimension but return a pairwise
// decision rather than numeric aspect scores.
export function buildJudgePrompt(input: JudgePromptInput): BuiltJudgePrompt {
  const dimensions = dimensionsForTrack(input.track);
  const labels = input.responseB !== null ? ["A", "B"] : ["A"];

  const systemPrompt = [
    "You are an independent quality auditor for a spiritual-guidance content product.",
    "You did not generate any response below and have no stake in which one is preferred.",
    "Evaluate every rubric dimension strictly, but do not assign numeric scores to individual aspects. Do not reward length or verbosity.",
    "Cite specific content from the responses in your rationale — general impressions are not acceptable.",
    "You have no information about which model or vendor produced any response; do not guess or mention one.",
  ].join(" ");

  const dimensionList = dimensions
    .map((d) => `- ${d.key} (${d.gate.toUpperCase()} gate): ${d.label} — ${d.description}`)
    .join("\n");

  const userPromptParts = [
    `TRACK: ${input.track}`,
    `RUBRIC VERSION: ${RUBRIC_VERSION}`,
    "",
    "RUBRIC DIMENSIONS TO ASSESS (inspect every dimension before deciding):",
    dimensionList,
    "",
    "INPUT DATA PROVIDED TO THE GENERATOR (every response label received this identical input):",
    JSON.stringify(input.inputSnapshot, null, 2),
  ];
  if (input.calcOutputs) {
    userPromptParts.push("", "DETERMINISTIC CALCULATION OUTPUTS (ground every grounding-dimension judgment against these):", JSON.stringify(input.calcOutputs, null, 2));
  }
  userPromptParts.push("", "RESPONSE A:", JSON.stringify(input.responseA, null, 2));
  if (input.responseB) {
    userPromptParts.push("", "RESPONSE B:", JSON.stringify(input.responseB, null, 2));
    userPromptParts.push(
      "",
      "After assessing every dimension, give an overall pairwise preference " +
        "(A better / B better / Tie). The service converts this comparison into the final percentage; do not return aspect scores.",
    );
  } else {
    userPromptParts.push("", "This is a single-arm baseline-regression check: assess RESPONSE A against the rubric, report hard-gate results and rationale, and do not return numeric scores.");
  }

  return {
    systemPrompt,
    userPrompt: userPromptParts.join("\n"),
    jsonSchema: buildJudgeSchema(dimensions, labels),
    dimensions,
    rubricVersion: RUBRIC_VERSION,
    labels,
  };
}
