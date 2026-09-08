import type { RenderedContent } from "./rendered-content.js";

export type MetricSpec = {
  key: string;
  gate: "hard" | "soft";
  class?: "factual" | "structural" | "quality" | "comparative";
};

export type Evidence = {
  candidateQuotes: Array<{ quote: string; section?: string | null }>;
  referenceQuotes: Array<{ quote: string; section?: string | null }>;
  inputRefs: Array<{ field: string; value?: string | null; note?: string | null }>;
  absences: Array<{ expected: string; scope: "section_missing" | "required_field_empty" | "input_fact_unaddressed" | "expected_element_absent"; note: string }>;
  rationale: string | null;
};

export type MetricResult = {
  score: number | null;
  abstainReason: "no_evidence_in_output" | "input_insufficient" | "metric_not_applicable" | "output_unintelligible" | null;
  evidence: Evidence;
  gate?: "pass" | "fail" | null;
  violation?: string | null;
};

export type JudgeResponse = {
  rowId: string;
  metrics: Record<string, MetricResult>;
  overall: { summary: string; confidence: "low" | "medium" | "high"; confidenceReason: string; silverComparison?: "equivalent" | "candidate_richer" | "silver_richer" | "substantive_disagreement" | "candidate_degenerate" | null };
};

export type ValidationIssue = { path: string; message: string };

export type ValidationContext = {
  rowId: string;
  metrics: readonly MetricSpec[];
  rendered: RenderedContent;
  candidateText: string;
  referenceText?: string;
  includeSilverReference: boolean;
};

export type ScoreRow = {
  userId: string;
  modelRef: string;
  track: string;
  metrics: Record<string, number | null>;
  gates: Record<string, boolean | null>;
  abstentions: Record<string, boolean>;
  degenerate?: boolean;
  costUsd?: number | null;
  latencyMs?: number | null;
};

export type BootstrapInterval = { estimate: number | null; lower: number | null; upper: number | null; n: number };
