import { resolveSecret } from "../../lib/secrets.js";
import { getProvider } from "../../providers/provider-factory.js";
import type { ProviderBinding } from "../../../shared/config-schema.js";
import type { RenderedPayload } from "../../core/pipeline/render.js";
import { judgeWithValidation, type JudgeAttempt, type JudgeAttemptContext, type JudgeRun } from "../../core/judge/runner.js";
import type { JudgePromptBundle } from "./prompt.js";
import { persistJudgeResult } from "./artifact-store.js";
import { finishLlmRequest, startLlmRequest } from "../../services/llm-request-service.js";
import type { Db } from "../../db.js";
import { promptMetrics } from "../../services/prompt-metrics.js";

export type JudgeTelemetry = { db: Db; jobId: string; runId: string; judgeRole: "primary" | "secondary"; requestId: string };
export type JudgePersistence = { db: Db; jobId: string | null; runId: string; judgeRole: "primary" | "secondary" };

export async function judgeRenderedPayload(payload: RenderedPayload, prompt: JudgePromptBundle, binding: ProviderBinding, telemetry?: JudgeTelemetry): Promise<JudgeRun> {
  if (binding.provider === "unset" || binding.model === "unset") throw new Error("judge provider and model must be configured before Phase 1 execution");
  const provider = getProvider(binding.provider);
  const apiKey = await resolveSecret(binding.secretRef);
  const metrics = promptMetrics(prompt.systemPrompt, prompt.userPrompt);
  return judgeWithValidation({
    rowId: payload.rowId,
    content: payload.content,
    candidateText: prompt.candidateText,
    referenceText: prompt.referenceText,
    includeSilverReference: Boolean(prompt.referenceText),
    metrics: prompt.metrics,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    jsonSchema: prompt.jsonSchema,
    complete: async (request) => {
      const result = await provider.complete({ ...request, model: binding.model }, apiKey);
      return { ...result, cacheReadInputTokens: result.cacheReadInputTokens ?? 0, systemPromptTokens: result.systemPromptTokens ?? metrics.systemPromptTokens, userPromptTokens: result.userPromptTokens ?? metrics.userPromptTokens, assistantContextTokens: result.assistantContextTokens ?? metrics.assistantContextTokens, promptCharacterCount: result.promptCharacterCount ?? metrics.promptCharacterCount, tokenBreakdownSource: result.tokenBreakdownSource ?? metrics.tokenBreakdownSource, systemPromptHash: result.systemPromptHash ?? metrics.systemPromptHash, userPromptHash: result.userPromptHash ?? metrics.userPromptHash, promptHash: result.userPromptHash ?? metrics.userPromptHash };
    },
    onAttemptStart: telemetry ? async ({ attempt, startedAt }) => startJudgeAttempt(telemetry, binding, prompt, attempt, startedAt) : undefined,
    onAttempt: telemetry ? async (attempt, context) => finishJudgeAttempt(telemetry, prompt, attempt, context) : undefined,
  });
}

export async function judgeAndPersistRenderedPayload(payload: RenderedPayload, prompt: JudgePromptBundle, binding: ProviderBinding, judgeEffort: string, telemetry?: JudgeTelemetry, persistence?: JudgePersistence): Promise<JudgeRun> {
  const result = await judgeRenderedPayload(payload, prompt, binding, telemetry);
  const persisted = telemetry ?? persistence;
  if (!persisted) return result;
  await persistJudgeResult({
    db: persisted.db,
    rowId: payload.rowId,
    runId: payload.runId,
    jobId: persisted.jobId,
    track: payload.track,
    userId: payload.userId,
    modelRef: payload.modelRef,
    judgeRole: persisted.judgeRole,
    judgeProvider: binding.provider,
    judgeModel: binding.model,
    judgeEffort,
    kernelHash: prompt.kernelHash,
    rubricPackHash: prompt.rubricPackHash,
    schemaHash: prompt.schemaHash,
    result,
  });
  return result;
}

async function startJudgeAttempt(telemetry: JudgeTelemetry, binding: ProviderBinding, prompt: JudgePromptBundle, attempt: number, startedAt: Date): Promise<JudgeAttemptContext> {
  const id = await startLlmRequest(telemetry.db, {
    jobId: telemetry.jobId,
    runId: telemetry.runId,
    requestKind: "judge",
    judgeRole: telemetry.judgeRole,
    requestId: `${telemetry.requestId}:${attempt}`,
    attempt,
    provider: binding.provider,
    model: binding.model,
    endpoint: binding.provider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : binding.provider === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/models/:generateContent"
        : binding.provider === "openai"
          ? "https://api.openai.com/v1/chat/completions"
          : "mock://judge",
    startedAt,
  });
  return id;
}

async function finishJudgeAttempt(telemetry: JudgeTelemetry, prompt: JudgePromptBundle, attempt: JudgeAttempt, context: JudgeAttemptContext): Promise<void> {
  if (typeof context !== "string") throw new Error("judge telemetry context was not created");
  const result = attempt.result;
  await finishLlmRequest(telemetry.db, context, {
    status: attempt.error ? "failed" : "succeeded",
    completedAt: attempt.completedAt,
    latencyMs: result?.latencyMs ?? attempt.completedAt.getTime() - attempt.startedAt.getTime(),
    providerRequestId: result?.providerRequestId,
    tokensPrompt: result?.promptTokens,
    tokensCompletion: result?.completionTokens,
    tokensTotal: result?.totalTokens,
    tokensCached: result?.cacheReadInputTokens,
    tokensCacheWrite: result?.cacheWriteInputTokens,
    tokensReasoning: result?.reasoningTokens,
    systemPromptTokens: result?.systemPromptTokens,
    userPromptTokens: result?.userPromptTokens,
    assistantContextTokens: result?.assistantContextTokens,
    promptCharacterCount: result?.promptCharacterCount,
    tokenBreakdownSource: result?.tokenBreakdownSource,
    costUsd: result?.costUsd,
    costStatus: result?.costUsd != null ? "known" : "unknown",
    costSource: result?.costUsd != null ? "provider" : "none",
    providerMetadata: { kernelHash: prompt.kernelHash, rubricPackHash: prompt.rubricPackHash, schemaHash: prompt.schemaHash, systemPromptHash: result?.systemPromptHash ?? null, userPromptHash: result?.userPromptHash ?? null, promptHash: result?.promptHash ?? null },
    error: attempt.error ?? null,
  });
}
