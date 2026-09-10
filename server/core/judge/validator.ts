import type { JudgeResponse, MetricResult, ValidationContext, ValidationIssue } from "../contracts/evaluation.js";

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const abstentionReasons = new Set(["no_evidence_in_output", "input_insufficient", "metric_not_applicable", "output_unintelligible"]);

function valueAt(fields: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : undefined;
}

function inputValuesMatch(actual: unknown, expected: string): boolean {
  const actualText = String(actual).trim().replace(/\s+/g, " ").toLowerCase();
  const expectedText = expected.trim().replace(/\s+/g, " ").toLowerCase();
  if (actualText === expectedText) return true;
  const parts = (value: string) => value.replace(/[°º]/g, "").split(/[,;]\s*/).map((part) => part.trim().replace(/^[a-z_]+\s*=\s*/, "").replace(/^(?:precision|position)\s+/, "")).filter(Boolean);
  const actualParts = parts(actualText);
  let expectedParts: string[];
  try {
    const parsed = JSON.parse(expectedText);
    expectedParts = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.values(parsed as Record<string, unknown>).flatMap((value) => parts(String(value))) : parts(expectedText);
  } catch {
    expectedParts = parts(expectedText);
  }
  if (actualParts.length !== expectedParts.length) return false;
  const remaining = [...expectedParts];
  return actualParts.every((actualPart) => {
    const match = remaining.findIndex((expectedPart) => {
    const actualNumber = Number(actualPart);
    const expectedNumber = Number(expectedPart);
      if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) return Math.abs(actualNumber - expectedNumber) <= 0.01;
      return actualPart === expectedPart;
    });
    if (match < 0) return false;
    remaining.splice(match, 1);
    return true;
  });
}

function validateMetric(metric: string, result: MetricResult, context: ValidationContext, hard: boolean, issues: ValidationIssue[]): void {
  const base = `metrics.${metric}`;
  if (!result || typeof result !== "object") { issues.push({ path: base, message: "metric result must be an object" }); return; }
  const evidence = result.evidence;
  if (!evidence || !Array.isArray(evidence.candidateQuotes) || !Array.isArray(evidence.referenceQuotes) || !Array.isArray(evidence.inputRefs) || !Array.isArray(evidence.absences)) {
    issues.push({ path: base, message: "evidence channels are required" }); return;
  }
  if (result.score !== null && typeof result.score !== "number") issues.push({ path: `${base}.score`, message: "score must be an integer or null" });
  if (result.abstainReason !== null && (typeof result.abstainReason !== "string" || !abstentionReasons.has(result.abstainReason))) issues.push({ path: `${base}.abstainReason`, message: "abstainReason is not recognized" });
  if ((typeof result.score === "number") === (typeof result.abstainReason === "string")) issues.push({ path: base, message: "exactly one of score or abstainReason must be non-null" });
  if (result.score !== null && result.score !== undefined && (!Number.isInteger(result.score) || result.score < 1 || result.score > 5)) issues.push({ path: `${base}.score`, message: "score must be an integer from 1 to 5" });
  if (result.score !== null && result.score !== undefined && evidence.candidateQuotes.length === 0 && evidence.absences.length === 0 && (!context.includeSilverReference || evidence.referenceQuotes.length === 0)) issues.push({ path: `${base}.evidence`, message: "a score requires a quote or absence" });
  if (evidence.candidateQuotes.length > 4 || evidence.referenceQuotes.length > 4 || evidence.inputRefs.length > 6 || evidence.absences.length > 6) issues.push({ path: `${base}.evidence`, message: "evidence channel exceeds its cap" });
  for (const [index, quote] of evidence.candidateQuotes.entries()) if (!normalize(context.candidateText).includes(normalize(quote.quote))) issues.push({ path: `${base}.evidence.candidateQuotes[${index}]`, message: "quote is not a verbatim candidate substring" });
  for (const [index, quote] of evidence.referenceQuotes.entries()) {
    if (!context.includeSilverReference || !context.referenceText) issues.push({ path: `${base}.evidence.referenceQuotes[${index}]`, message: "reference quote is not allowed without a silver reference" });
    else if (!normalize(context.referenceText).includes(normalize(quote.quote))) issues.push({ path: `${base}.evidence.referenceQuotes[${index}]`, message: "quote is not a verbatim reference substring" });
  }
  for (const [index, ref] of evidence.inputRefs.entries()) {
    const actual = valueAt(context.rendered.fields, ref.field);
    if (actual === undefined) issues.push({ path: `${base}.evidence.inputRefs[${index}]`, message: "input field does not resolve" });
    else if (ref.value !== undefined && ref.value !== null && !inputValuesMatch(actual, ref.value)) issues.push({ path: `${base}.evidence.inputRefs[${index}]`, message: "input value does not match" });
  }
  for (const [index, absence] of evidence.absences.entries()) {
    if ((absence.scope === "section_missing" || absence.scope === "required_field_empty") && context.rendered.sections.some((section) => section.path === absence.expected || section.name === absence.expected)) issues.push({ path: `${base}.evidence.absences[${index}]`, message: "declared section/field is present" });
    if (absence.scope === "input_fact_unaddressed" && evidence.inputRefs.length === 0) issues.push({ path: `${base}.evidence.absences[${index}]`, message: "input_fact_unaddressed requires an input reference" });
  }
  if (metric === "input_grounding" && result.score !== null && result.score !== undefined && evidence.inputRefs.length === 0) issues.push({ path: `${base}.evidence.inputRefs`, message: "grounding scores require input references" });
  if (hard && result.score !== null && result.score !== undefined) {
    if (result.gate === null || result.gate === undefined) issues.push({ path: `${base}.gate`, message: "hard-gate score requires a gate verdict" });
    if (result.gate === "fail" && !result.violation) issues.push({ path: `${base}.violation`, message: "failed gate requires a violation" });
    if (result.gate === "fail" && evidence.candidateQuotes.length === 0 && evidence.absences.length === 0) issues.push({ path: `${base}.gate`, message: "failed gate requires concrete evidence" });
  }
  if (result.abstainReason !== null && (result.gate !== null && result.gate !== undefined || evidence.candidateQuotes.length || evidence.referenceQuotes.length || evidence.inputRefs.length || evidence.absences.length)) issues.push({ path: base, message: "abstention cannot carry gate or evidence" });
}

export function validateJudgeResponse(value: unknown, context: ValidationContext): { ok: true; value: JudgeResponse } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!value || typeof value !== "object") return { ok: false, issues: [{ path: "", message: "response must be an object" }] };
  const response = value as Partial<JudgeResponse>;
  if (response.rowId !== context.rowId) issues.push({ path: "rowId", message: "rowId does not match the judged row" });
  if (!response.metrics || typeof response.metrics !== "object") issues.push({ path: "metrics", message: "metrics is required" });
  else {
    const keys = Object.keys(response.metrics);
    const expected = context.metrics.map((metric) => metric.key);
    for (const key of expected) if (!keys.includes(key)) issues.push({ path: "metrics", message: `missing metric ${key}` });
    for (const key of keys) if (!expected.includes(key)) issues.push({ path: "metrics", message: `unexpected metric ${key}` });
    for (const metric of context.metrics) validateMetric(metric.key, response.metrics[metric.key] as MetricResult, context, metric.gate === "hard", issues);
  }
  if (!response.overall || typeof response.overall !== "object") issues.push({ path: "overall", message: "overall is required" });
  else {
    if (typeof response.overall.summary !== "string" || !response.overall.summary.trim()) issues.push({ path: "overall.summary", message: "summary is required" });
    if (!(["low", "medium", "high"] as const).includes(response.overall.confidence)) issues.push({ path: "overall.confidence", message: "confidence must be low, medium, or high" });
    if (typeof response.overall.confidenceReason !== "string" || !response.overall.confidenceReason.trim()) issues.push({ path: "overall.confidenceReason", message: "confidenceReason is required" });
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: response as JudgeResponse };
}
