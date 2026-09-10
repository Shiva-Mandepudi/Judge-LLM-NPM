import { createHash } from "node:crypto";
import { countTokens } from "gpt-tokenizer";

export interface PromptMetrics {
  systemPromptTokens: number;
  userPromptTokens: number;
  assistantContextTokens: number;
  promptCharacterCount: number;
  tokenBreakdownSource: string;
  systemPromptHash: string;
  userPromptHash: string;
}

export function promptMetrics(systemPrompt: string, userPrompt: string): PromptMetrics {
  return {
    systemPromptTokens: countTokens(systemPrompt),
    userPromptTokens: countTokens(userPrompt),
    assistantContextTokens: 0,
    promptCharacterCount: systemPrompt.length + userPrompt.length,
    tokenBreakdownSource: "gpt-tokenizer:o200k_base-content",
    systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex"),
    userPromptHash: createHash("sha256").update(userPrompt).digest("hex"),
  };
}
