import crypto from "node:crypto";
import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaObject>;
}

function schemaLabels(schema: Record<string, unknown>, path: string): string[] {
  const root = schema as JsonSchemaObject;
  return Object.keys(root.properties?.[path]?.properties ?? {});
}

function hardGateKeysForLabel(schema: Record<string, unknown>, label: string): string[] {
  const root = schema as JsonSchemaObject;
  const perLabel = root.properties?.hardGateResults?.properties?.[label];
  return Object.keys(perLabel?.properties ?? {});
}

// Deterministic fake judge for local dev / tests. Never used outside
// NODE_ENV=test or explicit local dev opt-in (see provider-factory.ts guard).
export const mockProvider: JudgeProvider = {
  name: "mock",
  async complete(req: JudgeCompletionRequest): Promise<JudgeCompletionResult> {
    const labels = schemaLabels(req.jsonSchema, "hardGateResults");
    const hardGateResults: Record<string, Record<string, { pass: boolean; violationDetail: string | null }>> = {};

    for (const label of labels) {
      const gates: Record<string, { pass: boolean; violationDetail: string | null }> = {};
      hardGateKeysForLabel(req.jsonSchema, label).forEach((key) => {
        gates[key] = { pass: true, violationDetail: null };
      });
      hardGateResults[label] = gates;
    }

    const winnerHash = crypto.createHash("sha256").update(req.userPrompt).digest();
    const winnerRoll = winnerHash[winnerHash.length - 1] % 10;
    const winner = winnerRoll < 5 ? "Tie" : winnerRoll < 8 ? "A" : "B";

    return {
      parsed: {
        hardGateResults,
        ...(labels.length === 2 ? { pairwiseWinner: winner } : {}),
        rationale: "mock rationale",
        confidence: { level: "medium", reason: "mock provider, deterministic seed" },
      },
      raw: { mock: true },
      promptTokens: 300,
      completionTokens: 150,
      latencyMs: 5,
      costUsd: 0,
    };
  },
};
