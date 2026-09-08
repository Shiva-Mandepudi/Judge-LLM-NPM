export type Usage = { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
export type Rate = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function costForUsage(usage: Usage, rate: Rate, batchMultiplier = 1): number {
  const input = Math.max(0, usage.inputTokens - (usage.cacheReadInputTokens ?? 0) - (usage.cacheWriteInputTokens ?? 0));
  return batchMultiplier * (input * rate.input + (usage.cacheReadInputTokens ?? 0) * rate.cacheRead + (usage.cacheWriteInputTokens ?? 0) * rate.cacheWrite + usage.outputTokens * rate.output) / 1_000_000;
}

export function perUserCosts(rows: readonly { userId: string; costUsd?: number | null }[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((result, row) => { result[row.userId] = (result[row.userId] ?? 0) + (row.costUsd ?? 0); return result; }, {});
}

export function percentile(values: readonly number[], p: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]; }
