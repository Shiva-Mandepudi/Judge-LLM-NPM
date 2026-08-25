import { z } from "zod";
import { resolveSecret } from "../lib/secrets.js";
import { getProvider } from "../providers/provider-factory.js";
import { buildJudgePrompt, type JudgePromptInput } from "./judge-prompts.js";
import type { JudgeConfig, ProviderBinding } from "../../shared/config-schema.js";

const legacyDimensionScoreSchema = z.record(z.object({ score: z.number().int().min(1).max(5), justification: z.string() }));
const hardGateSchema = z.record(z.object({ pass: z.boolean(), violationDetail: z.string().nullable() }));

const judgeOutputSchema = z.object({
  // Compatibility field for historical rows. New judge calls do not request
  // or store numeric aspect scores.
  dimensionScores: z.record(legacyDimensionScoreSchema).default({}),
  hardGateResults: z.record(hardGateSchema), // keyed by response label
  pairwiseWinner: z.enum(["A", "B", "Tie"]).optional(),
  rationale: z.string(),
  confidence: z.object({ level: z.enum(["low", "medium", "high"]), reason: z.string() }),
});
export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export interface JudgeCallResult {
  output: JudgeOutput;
  provider: string;
  model: string;
  rubricVersion: string;
  latencyMs: number;
  costUsd: number | null;
}

const secretCache = new Map<string, string>();
async function getApiKey(secretRef: string): Promise<string> {
  let key = secretCache.get(secretRef);
  if (!key) {
    key = await resolveSecret(secretRef);
    secretCache.set(secretRef, key);
  }
  return key;
}

export async function callJudge(
  role: "primary_judge" | "secondary_judge",
  config: JudgeConfig,
  promptInput: JudgePromptInput,
): Promise<JudgeCallResult> {
  const binding: ProviderBinding = config.providers[role];
  if (binding.provider === "unset") {
    throw new Error(`Judge role "${role}" has no provider configured. An admin must publish a config with providers.${role} set.`);
  }
  const built = buildJudgePrompt(promptInput);
  const provider = getProvider(binding.provider);
  const apiKey = await getApiKey(binding.secretRef);

  const result = await provider.complete(
    { model: binding.model, systemPrompt: built.systemPrompt, userPrompt: built.userPrompt, jsonSchema: built.jsonSchema, schemaName: "judge_score" },
    apiKey,
  );

  const parsed = judgeOutputSchema.parse(result.parsed);
  return {
    output: parsed,
    provider: binding.provider,
    model: binding.model,
    rubricVersion: built.rubricVersion,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd ?? null,
  };
}
