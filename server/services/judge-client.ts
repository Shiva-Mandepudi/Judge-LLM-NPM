import { z } from "zod";
import { resolveSecret } from "../lib/secrets.js";
import { getProvider } from "../providers/provider-factory.js";
import { buildJudgePrompt, type JudgePromptInput } from "./judge-prompts.js";
import { promptMetrics } from "./prompt-metrics.js";
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
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  systemPromptTokens: number;
  userPromptTokens: number;
  assistantContextTokens: number;
  promptCharacterCount: number;
  tokenBreakdownSource: string;
  systemPromptHash: string;
  userPromptHash: string;
  providerRequestId?: string;
}

export function judgePromptMetrics(promptInput: JudgePromptInput) {
  const built = buildJudgePrompt(promptInput);
  return promptMetrics(built.systemPrompt, built.userPrompt);
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
  const metrics = promptMetrics(built.systemPrompt, built.userPrompt);
  return {
    output: parsed,
    provider: binding.provider,
    model: binding.model,
    rubricVersion: built.rubricVersion,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd ?? null,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    cacheWriteInputTokens: result.cacheWriteInputTokens,
    reasoningTokens: result.reasoningTokens,
    systemPromptTokens: result.systemPromptTokens ?? metrics.systemPromptTokens,
    userPromptTokens: result.userPromptTokens ?? metrics.userPromptTokens,
    assistantContextTokens: result.assistantContextTokens ?? metrics.assistantContextTokens,
    promptCharacterCount: result.promptCharacterCount ?? metrics.promptCharacterCount,
    tokenBreakdownSource: result.tokenBreakdownSource ?? metrics.tokenBreakdownSource,
    systemPromptHash: result.systemPromptHash ?? metrics.systemPromptHash,
    userPromptHash: result.userPromptHash ?? metrics.userPromptHash,
    providerRequestId: result.providerRequestId,
  };
}
