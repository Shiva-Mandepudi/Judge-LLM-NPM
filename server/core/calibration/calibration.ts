import type { JudgeResponse, ScoreRow } from "../contracts/evaluation.js";

export function agreementWithinOne(left: Record<string, number | null>, right: Record<string, number | null>): { rate: number; exactRate: number; compared: number } {
  const pairs = Object.keys(left).map((key) => [left[key], right[key]] as const).filter((pair): pair is [number, number] => typeof pair[0] === "number" && typeof pair[1] === "number");
  return { rate: pairs.length ? pairs.filter(([a, b]) => Math.abs(a - b) <= 1).length / pairs.length : 0, exactRate: pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : 0, compared: pairs.length };
}

export function gateAgreement(left: Record<string, boolean | null>, right: Record<string, boolean | null>): number { const pairs = Object.keys(left).map((key) => [left[key], right[key]] as const).filter((pair): pair is [boolean, boolean] => typeof pair[0] === "boolean" && typeof pair[1] === "boolean"); return pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : 0; }

export function sampleForCalibration<T>(rows: readonly T[], rate = 0.1): T[] { return rows.filter((_, index) => index % Math.max(1, Math.round(1 / rate)) === 0); }

export function scanForContamination(value: unknown, forbidden: readonly string[]): string[] { const hits: string[] = []; const visit = (item: unknown) => { if (typeof item === "string") { for (const token of forbidden) if (item.includes(token)) hits.push(token); return; } if (Array.isArray(item)) item.forEach(visit); else if (item && typeof item === "object") Object.values(item).forEach(visit); }; visit(value); return [...new Set(hits)]; }

export type ReviewSlice = { rowId: string; track: string; modelRef: string; response: JudgeResponse; status: "pending" | "reviewed"; reviewer?: string; reviewedAt?: string; note?: string };
export function importReview(slice: ReviewSlice, input: { reviewer: string; note: string; decision: "pass" | "fail" }): ReviewSlice { if (!input.reviewer.trim() || !input.note.trim()) throw new Error("reviewer and note are required"); return { ...slice, status: "reviewed", reviewer: input.reviewer, reviewedAt: new Date().toISOString(), note: `${input.decision}: ${input.note}` }; }

export function sanityFloorRanksLast(rows: readonly ScoreRow[], floorModel: string): boolean { const scores = new Map<string, number[]>(); for (const row of rows) { const value = Object.values(row.metrics).filter((score): score is number => typeof score === "number"); if (value.length) scores.set(row.modelRef, [...(scores.get(row.modelRef) ?? []), value.reduce((a, b) => a + b, 0) / value.length]); } const means = [...scores.entries()].map(([model, values]) => [model, values.reduce((a, b) => a + b, 0) / values.length] as const).sort((a, b) => a[1] - b[1]); return means.at(0)?.[0] === floorModel; }
