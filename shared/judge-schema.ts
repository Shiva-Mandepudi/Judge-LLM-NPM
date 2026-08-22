import type { RubricDimension } from "./rubric.js";

// JSON schema forced on the judge model's structured output (Anthropic
// tool_use input_schema / OpenAI response_format json_schema use the same
// draft-7-ish shape), mirroring the forced-schema pattern Cosmic Guidance
// already uses for its own generation calls (per the framework doc §2.1/§10).
//
// Dimension scores are captured PER RESPONSE LABEL (not holistically for the
// pair) so both statistical thresholds in the framework are computable from
// one judge call: the per-dimension non-inferiority delta (needs a mean per
// arm) and the pairwise win/tie/loss rate (needs the separate overall
// preference field). `labels` is ["A"] for single-arm baseline-regression
// tracks and ["A","B"] for comparative tracks.
export function buildJudgeSchema(dimensions: RubricDimension[], labels: string[]): Record<string, unknown> {
  const hardOnly = dimensions.filter((d) => d.gate === "hard");

  const perResponseDimensionSchema = {
    type: "object",
    properties: Object.fromEntries(
      dimensions.map((d) => [
        d.key,
        {
          type: "object",
          properties: { score: { type: "integer", minimum: 1, maximum: 5 }, justification: { type: "string", minLength: 1 } },
          required: ["score", "justification"],
          additionalProperties: false,
        },
      ]),
    ),
    required: dimensions.map((d) => d.key),
    additionalProperties: false,
  };

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
    dimensionScores: {
      type: "object",
      properties: Object.fromEntries(labels.map((l) => [l, perResponseDimensionSchema])),
      required: labels,
      additionalProperties: false,
    },
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
  const required = ["dimensionScores", "hardGateResults", "rationale", "confidence"];

  if (labels.length === 2) {
    properties.pairwiseWinner = { enum: ["A", "B", "Tie"] };
    required.push("pairwiseWinner");
  }

  return { type: "object", properties, required, additionalProperties: false };
}
