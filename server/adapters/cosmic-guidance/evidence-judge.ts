import { resolveSecret } from "../../lib/secrets.js";
import { getProvider } from "../../providers/provider-factory.js";
import type { ProviderBinding } from "../../../shared/config-schema.js";
import type { RenderedPayload } from "../../core/pipeline/render.js";
import { judgeWithValidation, type JudgeRun } from "../../core/judge/runner.js";
import type { JudgePromptBundle } from "./prompt.js";
import { persistJudgeResult } from "./artifact-store.js";

export async function judgeRenderedPayload(payload: RenderedPayload, prompt: JudgePromptBundle, binding: ProviderBinding): Promise<JudgeRun> {
  if (binding.provider === "unset" || binding.model === "unset") throw new Error("judge provider and model must be configured before Phase 1 execution");
  const provider = getProvider(binding.provider);
  const apiKey = await resolveSecret(binding.secretRef);
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
      return { parsed: result.parsed, raw: result.raw, promptTokens: result.promptTokens, completionTokens: result.completionTokens, cacheReadInputTokens: result.cacheReadInputTokens ?? 0, latencyMs: result.latencyMs, costUsd: result.costUsd };
    },
  });
}

export async function judgeAndPersistRenderedPayload(payload: RenderedPayload, prompt: JudgePromptBundle, binding: ProviderBinding, judgeEffort: string): Promise<JudgeRun> {
  const result = await judgeRenderedPayload(payload, prompt, binding);
  await persistJudgeResult({
    rowId: payload.rowId,
    runId: payload.runId,
    track: payload.track,
    userId: payload.userId,
    modelRef: payload.modelRef,
    judgeModel: binding.model,
    judgeEffort,
    kernelHash: prompt.kernelHash,
    rubricPackHash: prompt.rubricPackHash,
    schemaHash: prompt.schemaHash,
    result,
  });
  return result;
}
