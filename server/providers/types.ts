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
}

export interface JudgeProvider {
  readonly name: string;
  complete(req: JudgeCompletionRequest, apiKey: string): Promise<JudgeCompletionResult>;
}
