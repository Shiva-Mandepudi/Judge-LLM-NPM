import type { ModelsConfig } from "../config/schema.js";
import type { RenderedPayload } from "./render.js";

export type CostEstimate = {
  rows: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | "unknown";
  byTrack: Record<string, Omit<CostEstimate, "byTrack">>;
};

const tokenEstimate = (value: string) => Math.ceil(value.length / 4);

function estimateGroup(payloads: readonly RenderedPayload[], models: ModelsConfig): Omit<CostEstimate, "byTrack"> {
  const inputTokens = payloads.reduce((sum, payload) => sum + tokenEstimate(payload.content.text), 0);
  const outputTokens = payloads.length * 3500;
  const judgeModel = models.judge.primary.modelId;
  const rate = models.rates[judgeModel];
  return {
    rows: payloads.length,
    inputTokens,
    outputTokens,
    costUsd: rate ? inputTokens / 1_000_000 * rate.input + outputTokens / 1_000_000 * rate.output : "unknown",
  };
}

export function estimatePayloads(payloads: readonly RenderedPayload[], models: ModelsConfig): CostEstimate {
  const byTrack: Record<string, RenderedPayload[]> = {};
  for (const payload of payloads) (byTrack[payload.track] ??= []).push(payload);
  const total = estimateGroup(payloads, models);
  return { ...total, byTrack: Object.fromEntries(Object.entries(byTrack).map(([track, rows]) => [track, estimateGroup(rows, models)])) };
}
