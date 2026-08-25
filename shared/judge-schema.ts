import type { RubricDimension } from "./rubric.js";

// JSON schema forced on the judge model's structured output (Anthropic
// tool_use input_schema / OpenAI response_format json_schema use the same
// draft-7-ish shape), mirroring the forced-schema pattern Cosmic Guidance
// already uses for its own generation calls (per the framework doc §2.1/§10).
//
// Judges inspect every rubric dimension, but they do not emit a numeric score
// for each aspect. The evaluation result is the pairwise percentage derived
// from the winner/tie decision; hard gates remain pass/fail evidence.
export function buildJudgeSchema(dimensions: RubricDimension[], labels: string[]): Record<string, unknown> {
  const hardOnly = dimensions.filter((d) => d.gate === "hard");

  const perResponseHardGateSchema = {
    type: "object",
    properties: Object.fromEntries(
      hardOnly.map((d) => [
        d.key,
        {
          type: "object",
          properties: { pass: { type: "boolean" }, violationDetail: { type: ["string", "null"] } },
          required: ["pass", "violationDetail"],
          additionalProperties: false,
        },
      ]),
    ),
    required: hardOnly.map((d) => d.key),
    additionalProperties: false,
  };

  const properties: Record<string, unknown> = {
    hardGateResults: {
      type: "object",
      properties: Object.fromEntries(labels.map((l) => [l, perResponseHardGateSchema])),
      required: labels,
      additionalProperties: false,
    },
    rationale: { type: "string", minLength: 1 },
    confidence: {
      type: "object",
      properties: { level: { enum: ["low", "medium", "high"] }, reason: { type: "string" } },
      required: ["level", "reason"],
      additionalProperties: false,
    },
  };
  const required = ["hardGateResults", "rationale", "confidence"];

  if (labels.length === 2) {
    properties.pairwiseWinner = { enum: ["A", "B", "Tie"] };
    required.push("pairwiseWinner");
  }

  return { type: "object", properties, required, additionalProperties: false };
}
