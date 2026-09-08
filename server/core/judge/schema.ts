import type { MetricSpec } from "../contracts/evaluation.js";

const evidenceSchema = {
  type: "object", additionalProperties: false,
  required: ["candidateQuotes", "referenceQuotes", "inputRefs", "absences", "rationale"],
  properties: {
    candidateQuotes: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["quote"], properties: { quote: { type: "string", maxLength: 300 }, section: { type: ["string", "null"] } } } },
    referenceQuotes: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["quote"], properties: { quote: { type: "string", maxLength: 300 }, section: { type: ["string", "null"] } } } },
    inputRefs: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["field"], properties: { field: { type: "string", maxLength: 120 }, value: { type: ["string", "null"], maxLength: 200 }, note: { type: ["string", "null"], maxLength: 200 } } } },
    absences: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["expected", "scope", "note"], properties: { expected: { type: "string", maxLength: 200 }, scope: { type: "string", enum: ["section_missing", "required_field_empty", "input_fact_unaddressed", "expected_element_absent"] }, note: { type: "string", maxLength: 300 } } } },
    rationale: { type: ["string", "null"], maxLength: 500 },
  },
};

export function buildEvidenceJudgeSchema(metrics: readonly MetricSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const metric of metrics) {
    properties[metric.key] = {
      type: "object", additionalProperties: false,
      required: ["score", "abstainReason", "evidence", ...(metric.gate === "hard" ? ["gate", "violation"] : [])],
      properties: {
        score: { type: ["integer", "null"], minimum: 1, maximum: 5 },
        abstainReason: { type: ["string", "null"], enum: ["no_evidence_in_output", "input_insufficient", "metric_not_applicable", "output_unintelligible", null] },
        evidence: evidenceSchema,
        ...(metric.gate === "hard" ? { gate: { type: ["string", "null"], enum: ["pass", "fail", null] }, violation: { type: ["string", "null"], maxLength: 400 } } : {}),
      },
    };
  }
  return {
    type: "object", additionalProperties: false, required: ["rowId", "metrics", "overall"],
    properties: {
      rowId: { type: "string" },
      metrics: { type: "object", additionalProperties: false, properties, required: metrics.map((metric) => metric.key) },
      overall: { type: "object", additionalProperties: false, required: ["summary", "confidence", "confidenceReason"], properties: { summary: { type: "string", maxLength: 600 }, confidence: { type: "string", enum: ["low", "medium", "high"] }, confidenceReason: { type: "string", maxLength: 300 }, silverComparison: { type: ["string", "null"], enum: ["equivalent", "candidate_richer", "silver_richer", "substantive_disagreement", "candidate_degenerate", null] } } },
    },
  };
}
