import type { JudgeResponse, MetricSpec, ValidationContext } from "../contracts/evaluation.js";
import type { RenderedContent } from "../contracts/rendered-content.js";
import { validateJudgeResponse } from "./validator.js";

export type JudgeCompletion = { parsed: unknown; raw: unknown; promptTokens: number; completionTokens: number; cacheReadInputTokens: number; latencyMs: number; costUsd: number | null };
export type JudgeCompletionProvider = (request: { systemPrompt: string; userPrompt: string; jsonSchema: Record<string, unknown>; schemaName: string }) => Promise<JudgeCompletion>;
export type JudgeRun = { status: "ok" | "invalid" | "error"; attempts: number; response?: JudgeResponse; raw?: unknown; usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number }; latencyMs: number; costUsd: number | null; issues?: { path: string; message: string }[] };

export async function judgeWithValidation(input: { rowId: string; content: RenderedContent; candidateText: string; referenceText?: string; includeSilverReference: boolean; metrics: readonly MetricSpec[]; systemPrompt: string; userPrompt: string; jsonSchema: Record<string, unknown>; complete: JudgeCompletionProvider }): Promise<JudgeRun> {
  let requestPrompt = input.userPrompt;
  let lastIssues: { path: string; message: string }[] = [];
  let last: JudgeCompletion | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      last = await input.complete({ systemPrompt: input.systemPrompt, userPrompt: requestPrompt, jsonSchema: input.jsonSchema, schemaName: "judge_score" });
      const result = validateJudgeResponse(last.parsed, { rowId: input.rowId, metrics: input.metrics, rendered: input.content, candidateText: input.candidateText, referenceText: input.referenceText, includeSilverReference: input.includeSilverReference });
      if (result.ok) return { status: "ok", attempts: attempt, response: result.value, raw: last.raw, usage: { inputTokens: last.promptTokens, outputTokens: last.completionTokens, cacheReadInputTokens: last.cacheReadInputTokens }, latencyMs: last.latencyMs, costUsd: last.costUsd };
      lastIssues = result.issues;
      requestPrompt = `${input.userPrompt}\n\nCORRECTION: your prior response was invalid. Fix exactly these contract violations and return the complete object: ${lastIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
    } catch (error) {
      return { status: "error", attempts: attempt, raw: last?.raw, usage: { inputTokens: last?.promptTokens ?? 0, outputTokens: last?.completionTokens ?? 0, cacheReadInputTokens: last?.cacheReadInputTokens ?? 0 }, latencyMs: last?.latencyMs ?? 0, costUsd: last?.costUsd ?? null, issues: [{ path: "provider", message: String(error) }] };
    }
  }
  return { status: "invalid", attempts: 2, raw: last?.raw, usage: { inputTokens: last?.promptTokens ?? 0, outputTokens: last?.completionTokens ?? 0, cacheReadInputTokens: last?.cacheReadInputTokens ?? 0 }, latencyMs: last?.latencyMs ?? 0, costUsd: last?.costUsd ?? null, issues: lastIssues };
}
