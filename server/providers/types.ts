export interface JudgeCompletionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}

export interface JudgeCompletionResult {
  parsed: Record<string, unknown>;
  raw: unknown;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number | null;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  systemPromptTokens?: number;
  userPromptTokens?: number;
  assistantContextTokens?: number;
  promptCharacterCount?: number;
  tokenBreakdownSource?: string;
  systemPromptHash?: string;
  userPromptHash?: string;
  providerRequestId?: string;
}

export interface JudgeProvider {
  readonly name: string;
  complete(req: JudgeCompletionRequest, apiKey: string): Promise<JudgeCompletionResult>;
}
