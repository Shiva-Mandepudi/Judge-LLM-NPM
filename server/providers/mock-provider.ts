import crypto from "node:crypto";
import type { JudgeProvider, JudgeCompletionRequest, JudgeCompletionResult } from "./types.js";

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaObject>;
}

function schemaLabels(schema: Record<string, unknown>, path: string): string[] {
  const root = schema as JsonSchemaObject;
  return Object.keys(root.properties?.[path]?.properties ?? {});
}

function dimensionKeysForLabel(schema: Record<string, unknown>, label: string): string[] {
  const root = schema as JsonSchemaObject;
  const perLabel = root.properties?.dimensionScores?.properties?.[label];
  return Object.keys(perLabel?.properties ?? {});
}

function hardGateKeysForLabel(schema: Record<string, unknown>, label: string): string[] {
  const root = schema as JsonSchemaObject;
  const perLabel = root.properties?.hardGateResults?.properties?.[label];
  return Object.keys(perLabel?.properties ?? {});
}

// Deterministic fake judge for local dev / tests. Derives stable scores from
// a hash of the prompt so repeated runs are reproducible. Never used outside
// NODE_ENV=test or explicit local dev opt-in (see provider-factory.ts guard).
export const mockProvider: JudgeProvider = {
  name: "mock",
  async complete(req: JudgeCompletionRequest): Promise<JudgeCompletionResult> {
    const labels = schemaLabels(req.jsonSchema, "dimensionScores");
    const dimensionScores: Record<string, Record<string, { score: number; justification: string }>> = {};
    const hardGateResults: Record<string, Record<string, { pass: boolean; violationDetail: string | null }>> = {};

    for (const label of labels) {
      const hash = crypto.createHash("sha256").update(`${req.userPrompt}:${label}`).digest();
      const dims: Record<string, { score: number; justification: string }> = {};
      dimensionKeysForLabel(req.jsonSchema, label).forEach((key, i) => {
        // Candidate arm (label "B" by this fixture's convention) is nudged
        // slightly lower so non-inferiority tests have a non-trivial signal.
        const base = 3 + ((hash[i % hash.length] % 3) - 1);
        dims[key] = { score: Math.max(1, Math.min(5, label === "B" ? base - 1 : base)), justification: `mock justification for ${key}/${label}` };
      });
      dimensionScores[label] = dims;

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
        dimensionScores,
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
