import type { Db } from "../db.js";
import { eq } from "drizzle-orm";
import { evalLlmRequestAttempts, type LlmRequestAttemptStatus, type LlmRequestKind } from "../../shared/schema.js";

export interface LlmRequestStart {
  jobId: string;
  runId: string | null;
  requestKind: LlmRequestKind;
  judgeRole?: "primary" | "secondary";
  requestId: string;
  attempt: number;
  provider: string;
  model: string;
  endpoint: string;
  startedAt: Date;
}

export interface LlmRequestFinish {
  status: Exclude<LlmRequestAttemptStatus, "started">;
  completedAt: Date;
  latencyMs: number;
  providerRequestId?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;
  tokensCached?: number | null;
  tokensCacheWrite?: number | null;
  tokensReasoning?: number | null;
  tokensAcceptedPrediction?: number | null;
  tokensRejectedPrediction?: number | null;
  systemPromptTokens?: number | null;
  userPromptTokens?: number | null;
  assistantContextTokens?: number | null;
  promptCharacterCount?: number | null;
  tokenBreakdownSource?: string | null;
  costUsd?: number | null;
  costStatus?: string | null;
  costSource?: string | null;
  providerMetadata?: unknown;
  error?: string | null;
}

export async function startLlmRequest(db: Db, input: LlmRequestStart): Promise<string> {
  const [row] = await db.insert(evalLlmRequestAttempts).values({
    jobId: input.jobId,
    runId: input.runId,
    requestKind: input.requestKind,
    judgeRole: input.judgeRole ?? null,
    requestId: input.requestId,
    attempt: input.attempt,
    provider: input.provider,
    model: input.model,
    endpoint: input.endpoint,
    status: "started",
    startedAt: input.startedAt,
  }).returning({ id: evalLlmRequestAttempts.id });
  if (!row) throw new Error("LLM request telemetry row was not created; provider call refused");
  return row.id;
}

export async function finishLlmRequest(db: Db, id: string, result: LlmRequestFinish): Promise<void> {
  await db.update(evalLlmRequestAttempts).set({
    status: result.status,
    completedAt: result.completedAt,
    latencyMs: result.latencyMs,
    providerRequestId: result.providerRequestId ?? null,
    tokensPrompt: result.tokensPrompt ?? null,
    tokensCompletion: result.tokensCompletion ?? null,
    tokensTotal: result.tokensTotal ?? null,
    tokensCached: result.tokensCached ?? null,
    tokensCacheWrite: result.tokensCacheWrite ?? null,
    tokensReasoning: result.tokensReasoning ?? null,
    tokensAcceptedPrediction: result.tokensAcceptedPrediction ?? null,
    tokensRejectedPrediction: result.tokensRejectedPrediction ?? null,
    systemPromptTokens: result.systemPromptTokens ?? null,
    userPromptTokens: result.userPromptTokens ?? null,
    assistantContextTokens: result.assistantContextTokens ?? null,
    promptCharacterCount: result.promptCharacterCount ?? null,
    tokenBreakdownSource: result.tokenBreakdownSource ?? null,
    costUsd: result.costUsd ?? null,
    costStatus: result.costStatus ?? null,
    costSource: result.costSource ?? null,
    providerMetadata: result.providerMetadata ?? null,
    error: result.error ?? null,
  }).where(eq(evalLlmRequestAttempts.id, id));
}
