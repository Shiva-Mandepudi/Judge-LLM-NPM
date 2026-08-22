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
// unlabeled shared input data, model identity stripped, do-not-reward-length
// instruction, forced justification-before-score via schema, dimension
// scores captured per response label so per-arm means are computable.
export function buildJudgePrompt(input: JudgePromptInput): BuiltJudgePrompt {
  const dimensions = dimensionsForTrack(input.track);
  const labels = input.responseB !== null ? ["A", "B"] : ["A"];

  const systemPrompt = [
    "You are an independent quality auditor for a spiritual-guidance content product.",
    "You did not generate any response below and have no stake in which one is preferred.",
    "Score strictly against the rubric provided, for EACH response label independently. Do not reward length or verbosity.",
    "Cite specific content from the response in every justification — general impressions are not acceptable.",
    "You have no information about which model or vendor produced any response; do not guess or mention one.",
  ].join(" ");

  const dimensionList = dimensions
    .map((d) => `- ${d.key} (${d.gate.toUpperCase()} gate): ${d.label} — ${d.description}`)
    .join("\n");

  const userPromptParts = [
    `TRACK: ${input.track}`,
    `RUBRIC VERSION: ${RUBRIC_VERSION}`,
    "",
    "DIMENSIONS TO SCORE (score every dimension for every response label listed below):",
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
      "After scoring A and B independently on every dimension, give an overall pairwise preference " +
        "(A better / B better / Tie) with a one-sentence rationale citing specific content from both.",
    );
  } else {
    userPromptParts.push("", "This is a single-arm baseline-regression check: score RESPONSE A against the rubric only, no comparison.");
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
