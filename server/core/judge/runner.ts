import type { JudgeResponse, MetricSpec, ValidationContext } from "../contracts/evaluation.js";
import type { RenderedContent } from "../contracts/rendered-content.js";
import { validateJudgeResponse } from "./validator.js";

export type JudgeCompletion = {
  parsed: unknown;
  raw: unknown;
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  systemPromptTokens?: number;
  userPromptTokens?: number;
  assistantContextTokens?: number;
  promptCharacterCount?: number;
  tokenBreakdownSource?: string;
  providerRequestId?: string;
  systemPromptHash?: string;
  promptHash?: string;
  userPromptHash?: string;
  latencyMs: number;
  costUsd: number | null;
};
export type JudgeAttempt = { attempt: number; startedAt: Date; completedAt: Date; result?: JudgeCompletion; error?: string };
export type JudgeAttemptContext = unknown;
export type JudgeCompletionProvider = (request: { systemPrompt: string; userPrompt: string; jsonSchema: Record<string, unknown>; schemaName: string }) => Promise<JudgeCompletion>;
export type JudgeRun = { status: "ok" | "invalid" | "error"; attempts: number; response?: JudgeResponse; raw?: unknown; usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number; reasoningTokens: number; systemPromptTokens: number; userPromptTokens: number; assistantContextTokens: number; promptCharacterCount: number; tokenBreakdownSource: string | null; providerRequestId: string | null; systemPromptHash: string | null; userPromptHash: string | null; promptHash: string | null }; latencyMs: number; costUsd: number | null; issues?: { path: string; message: string }[] };

export async function judgeWithValidation(input: { rowId: string; content: RenderedContent; candidateText: string; referenceText?: string; includeSilverReference: boolean; metrics: readonly MetricSpec[]; systemPrompt: string; userPrompt: string; jsonSchema: Record<string, unknown>; complete: JudgeCompletionProvider; onAttemptStart?: (attempt: { attempt: number; startedAt: Date }) => Promise<JudgeAttemptContext>; onAttempt?: (attempt: JudgeAttempt, context?: JudgeAttemptContext) => Promise<void> }): Promise<JudgeRun> {
  let requestPrompt = input.userPrompt;
  let lastIssues: { path: string; message: string }[] = [];
  let last: JudgeCompletion | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = new Date();
    let attemptContext: JudgeAttemptContext;
    try {
      attemptContext = await input.onAttemptStart?.({ attempt, startedAt });
      last = await input.complete({ systemPrompt: input.systemPrompt, userPrompt: requestPrompt, jsonSchema: input.jsonSchema, schemaName: "judge_score" });
      await input.onAttempt?.({ attempt, startedAt, completedAt: new Date(), result: last }, attemptContext);
      // rowId is an internal envelope binding, not an LLM decision. The model
      // must not be given run/job identifiers just to echo them back; bind the
      // validated response to the request that produced it.
      const parsed = last.parsed && typeof last.parsed === "object" && !Array.isArray(last.parsed)
        ? { ...(last.parsed as Record<string, unknown>), rowId: input.rowId }
        : last.parsed;
      const result = validateJudgeResponse(parsed, { rowId: input.rowId, metrics: input.metrics, rendered: input.content, candidateText: input.candidateText, referenceText: input.referenceText, includeSilverReference: input.includeSilverReference });
      if (result.ok) return { status: "ok", attempts: attempt, response: result.value, raw: last.raw, usage: usageOf(last), latencyMs: last.latencyMs, costUsd: last.costUsd };
      lastIssues = result.issues;
      requestPrompt = `${input.userPrompt}\n\nCORRECTION: your prior response was invalid. Fix exactly these contract violations and return the complete object: ${lastIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.onAttempt?.({ attempt, startedAt, completedAt: new Date(), result: last, error: message }, attemptContext);
      return { status: "error", attempts: attempt, raw: last?.raw, usage: usageOf(last), latencyMs: last?.latencyMs ?? 0, costUsd: last?.costUsd ?? null, issues: [{ path: "provider", message }] };
    }
  }
  return { status: "invalid", attempts: 2, raw: last?.raw, usage: usageOf(last), latencyMs: last?.latencyMs ?? 0, costUsd: last?.costUsd ?? null, issues: lastIssues };
}

function usageOf(completion: JudgeCompletion | undefined): JudgeRun["usage"] {
  return { inputTokens: completion?.promptTokens ?? 0, outputTokens: completion?.completionTokens ?? 0, totalTokens: completion?.totalTokens ?? (completion ? completion.promptTokens + completion.completionTokens : 0), cacheReadInputTokens: completion?.cacheReadInputTokens ?? 0, cacheWriteInputTokens: completion?.cacheWriteInputTokens ?? 0, reasoningTokens: completion?.reasoningTokens ?? 0, systemPromptTokens: completion?.systemPromptTokens ?? 0, userPromptTokens: completion?.userPromptTokens ?? 0, assistantContextTokens: completion?.assistantContextTokens ?? 0, promptCharacterCount: completion?.promptCharacterCount ?? 0, tokenBreakdownSource: completion?.tokenBreakdownSource ?? null, providerRequestId: completion?.providerRequestId ?? null, systemPromptHash: completion?.systemPromptHash ?? null, userPromptHash: completion?.userPromptHash ?? null, promptHash: completion?.promptHash ?? null };
}
