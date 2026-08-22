import type { EvalTrack } from "./schema.js";

// judge-llm-evaluation-framework.md §6.1 "Sample sizes" — the launch-gate
// minimum before a non-inferiority result can be trusted. Below this, a
// "pass"/"rollback" is a statistically premature claim, not a real signal.
export const MIN_SAMPLE_SIZE_BY_TRACK: Record<EvalTrack, number> = {
  my_day_model_comparison: 150,
  my_day_batch_vs_live: 50, // §7.2 Check B recommended n=50
  numerology: 142, // §5 exhaustive protocol — all of it, not a sample
  brief_readings: 100, // per reading-type tag, see MIN_SAMPLE_SIZE_BY_TAG
  ai_chat: 100, // conversations, not messages
  safety_injection: 30, // not enumerated in §6.1; treated like a baseline-regression floor
};

// brief_readings lumps natal/transit/synastry/composite/number_compat/tarot
// into one DB track (dataset cases tag themselves by reading type) — the
// framework requires each reading type to clear its OWN n=100, not share one
// pooled count across all of them.
export const MIN_SAMPLE_SIZE_BY_TAG: Record<string, number> = {
  natal: 100,
  transit: 100,
  synastry: 100,
  composite: 100,
  number_compat: 100,
  tarot: 100,
};

export function minSampleSizeFor(track: EvalTrack, tag?: string): number {
  if (tag && tag in MIN_SAMPLE_SIZE_BY_TAG) return MIN_SAMPLE_SIZE_BY_TAG[tag];
  return MIN_SAMPLE_SIZE_BY_TRACK[track] ?? 30;
}
