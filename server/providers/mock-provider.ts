import crypto from "node:crypto";
import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

type Schema = { properties?: Record<string, Schema & { required?: string[] }> };

function candidateQuote(prompt: string): string {
  const section = prompt.split("## READING UNDER REVIEW\n")[1]?.split("## SILVER REFERENCE\n")[0] ?? "reading under review";
  const text = section.replace(/^### [^\n]+\n/gm, "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

export const mockProvider: JudgeProvider = {
  name: "mock",
  async complete(req: JudgeCompletionRequest): Promise<JudgeCompletionResult> {
    const schema = req.jsonSchema as Schema;
    const metricProperties = schema.properties?.metrics?.properties ?? {};
    const quote = candidateQuote(req.userPrompt);
    const metrics: Record<string, unknown> = {};
    for (const [key, metric] of Object.entries(metricProperties)) {
      const hard = metric.required?.includes("gate") ?? false;
      metrics[key] = { score: 3, abstainReason: null, evidence: { candidateQuotes: [{ quote }], referenceQuotes: [], inputRefs: [], absences: [], rationale: "deterministic mock evidence" }, ...(hard ? { gate: "pass", violation: null } : {}) };
    }
    const digest = crypto.createHash("sha256").update(req.userPrompt).digest("hex");
    return { parsed: { rowId: req.userPrompt.match(/rowId[^a-zA-Z0-9-]+([a-zA-Z0-9-]+)/)?.[1] ?? "mock-row", metrics, overall: { summary: `mock-${digest.slice(0, 8)}`, confidence: "medium", confidenceReason: "deterministic mock provider" } }, raw: { mock: true }, promptTokens: 300, completionTokens: 150, totalTokens: 450, latencyMs: 5, costUsd: 0 };
  },
};
