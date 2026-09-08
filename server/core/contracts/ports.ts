// The five interfaces product-specific code must cross through. core/ defines them,
// adapters implement them. Nothing else crosses the boundary — see
// docs/LLM PLAN/03-build-plan/00-architecture-and-parametrization.md#the-ports
import type { RenderedContent, Row, UserId } from "./rendered-content.js";
import type { TrackSpec } from "../config/schema.js";

export type RawRow = {
  userId: UserId;
  track: string;
  stratum: Record<string, string | number | boolean | null>;
  inputSnapshot: unknown;
  candidateOutput: unknown;
  candidateSchemaValid: boolean | null; // null = adapter has no signal; core reads it as unparseable
  silverOutput: unknown;
  generation: { inputTokens: number; outputTokens: number; latencyMs: number };
};

export interface Datasource {
  listUsers(): Promise<UserId[]>;
  fetchRows(track: string, users: UserId[]): Promise<RawRow[]>;
}

export interface Renderer {
  render(raw: RawRow): RenderedContent;
}

export type Stratum = Record<string, string | number | boolean | null>;

export interface Stratifier {
  stratumOf(raw: RawRow): Stratum;
}

export type { TrackSpec };

export type JudgePayload = {
  schema: unknown;
  content: RenderedContent;
};

// Deliberately has no "applied"/"committed" field: the engine recommends, it never
// decides (rule #6 in docs/REBUILD-PLAN.md §0). Any adapter or caller that needs to
// act on a Judgement does so outside this contract, from a human-reviewed decisions.json.
export type Judgement = {
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
};

export interface JudgeProvider {
  score(payload: JudgePayload): Promise<Judgement>;
}

export type { Row };
