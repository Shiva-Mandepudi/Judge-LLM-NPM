// The one shape every adapter must produce and the only shape core/ understands.
// See docs/LLM PLAN/03-build-plan/00-architecture-and-parametrization.md#the-ports
export type RenderedContent = {
  sections: Array<{ name: string; path: string; text: string }>; // stable order
  fields: Record<string, string | number | boolean | null>; // addressable for inputRefs
  text: string; // the rendered whole
};

export type LoadStatus = "ok" | "unparseable" | "missing_candidate" | "missing_silver";

// The atom of the system. userId is the cluster key the statistical design depends on.
export type Row = {
  rowId: string; // sha256(runId|userId|track|stratumKey|modelRef)
  runId: string;
  userId: string;
  track: string;
  stratum: Record<string, string | number | boolean | null>;
  modelRef: string; // opaque until stage 5 (sealed model map)
  inputSnapshot: unknown;
  candidateOutput: unknown;
  silverOutput: unknown;
  generation: { inputTokens: number; outputTokens: number; latencyMs: number };
  loadStatus: LoadStatus;
  // Visible, per-row form of any open config/blockers.yaml item that affects this
  // row's provenance (e.g. champion-model-confirmation, production-corpus-reconciliation)
  // — a caveat stamped on the data itself, not just recorded in a doc a reader has to
  // go find. Absent once the corresponding blocker closes.
  provenance?: Record<string, boolean>;
};

export type UserId = string;
