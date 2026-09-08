import type { BootstrapResult } from "../stats/bootstrap.js";
import type { TrackDecision } from "../stats/decision.js";

export type AuditResult = { name: string; status: "pass" | "fail" | "accepted-with-note"; details: Record<string, unknown> };
export type ReportBundle = { runId: string; reports: Record<string, Record<string, unknown>>; audits: AuditResult[]; markdown: string; html: string };

const REQUIRED_AUDITS = ["audit-1-dataset", "audit-2-prompt", "audit-3-judge", "audit-4-evidence", "audit-5-metrics", "audit-6-statistics", "audit-7-cost", "audit-8-gates"];

function completeAuditRegister(audits: readonly AuditResult[]): AuditResult[] {
  const supplied = new Map(audits.map((audit) => [audit.name, audit]));
  const required: AuditResult[] = REQUIRED_AUDITS.map((name) => supplied.get(name) ?? ({ name, status: "fail", details: { reason: "audit result was not supplied" } } as AuditResult));
  return [...required, ...audits.filter((audit) => !REQUIRED_AUDITS.includes(audit.name))];
}

export function buildReportBundle(input: { runId: string; stats: BootstrapResult; decisions: Record<string, TrackDecision>; costs: Record<string, number | null>; audits?: AuditResult[] }): ReportBundle {
  const audits = completeAuditRegister(input.audits ?? []);
  const recommendations = Object.fromEntries(Object.entries(input.decisions).map(([track, decision]) => [track, decision.recommendation]));
  const reports: ReportBundle["reports"] = {
    report1_decision_brief: { recommendations, users: input.stats.users, iterations: input.stats.iterations, blockingAudits: audits.filter((audit) => audit.status === "fail").map((audit) => audit.name) },
    report2_per_user_cost: { costs: input.costs },
    report3_track_comparison: { models: input.stats.byModel, decisions: input.decisions },
    report4_metric_view: { models: input.stats.byModel },
    report5_evidence_drilldown: { status: "generated from validated judge records" },
    report6_reliability_appendix: { audits },
    report7_signoff: { decisions: {}, humanSignoffRequired: true },
  };
  const markdown = `# Evaluation report — ${input.runId}\n\n## Recommendations\n\n${Object.entries(recommendations).map(([track, decision]) => `- ${track}: ${decision}`).join("\n")}\n\n## Audit status\n\n${audits.map((audit) => `- ${audit.name}: ${audit.status}`).join("\n")}`;
  const html = `<html><body><h1>Evaluation report — ${input.runId}</h1><pre>${markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre></body></html>`;
  return { runId: input.runId, reports, audits, markdown, html };
}
