import type { JudgeConfig } from "../../shared/config-schema.js";

export function computeCostUsd(config: JudgeConfig, model: string, promptTokens: number, completionTokens: number): number | null {
  const rate = config.costRatesUsdPer1kTokens[model];
  if (!rate) return null; // unknown model rate: report null rather than guessing, surfaced in results as "cost unknown"
  return (promptTokens / 1000) * rate.promptPer1k + (completionTokens / 1000) * rate.completionPer1k;
}
