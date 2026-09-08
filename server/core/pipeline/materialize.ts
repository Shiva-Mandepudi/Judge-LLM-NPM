import { createHash } from "node:crypto";
import type { Datasource } from "../contracts/ports.js";
import type { LoadStatus, Row, UserId } from "../contracts/rendered-content.js";
import type { TrackSpec } from "../config/schema.js";

export type CoverageRecord = {
  track: string;
  expected: number;
  actual: number;
  status: "ready" | "NO RECOMMENDATION";
  reason?: string;
};

export function loadStatusOf(candidateOutput: unknown, candidateSchemaValid: boolean | null): LoadStatus {
  if (candidateOutput === null || candidateOutput === undefined) return "missing_candidate";
  if (candidateSchemaValid === false) return "unparseable";
  return "ok";
}

export function rowId(runId: string, userId: string, track: string, stratum: Record<string, unknown>, modelRef: string): string {
  const stratumKey = JSON.stringify(stratum, Object.keys(stratum).sort());
  return createHash("sha256").update(`${runId}|${userId}|${track}|${stratumKey}|${modelRef}`).digest("hex");
}

export function rowsJsonl(rows: readonly Row[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

export async function materializeRows(
  runId: string,
  datasource: Datasource,
  tracks: readonly TrackSpec[],
  modelRef: string,
  users?: UserId[],
): Promise<{ rows: Row[]; coverage: CoverageRecord[]; users: UserId[] }> {
  const resolvedUsers = users ?? await datasource.listUsers();
  const rows: Row[] = [];
  const coverage: CoverageRecord[] = [];
  for (const track of tracks) {
    const rawRows = await datasource.fetchRows(track.track, resolvedUsers);
    const expected = resolvedUsers.length * track.rowsPerUser;
    coverage.push({
      track: track.track,
      expected,
      actual: rawRows.length,
      status: rawRows.length === expected ? "ready" : "NO RECOMMENDATION",
      ...(rawRows.length === expected ? {} : { reason: rawRows.length === 0 ? "no candidate rows" : "partial candidate coverage" }),
    });
    rows.push(...rawRows.map((raw) => ({
      rowId: rowId(runId, raw.userId, track.track, raw.stratum, modelRef),
      runId,
      userId: raw.userId,
      track: track.track,
      stratum: raw.stratum,
      modelRef,
      inputSnapshot: raw.inputSnapshot,
      candidateOutput: raw.candidateOutput,
      silverOutput: raw.silverOutput,
      generation: raw.generation,
      loadStatus: loadStatusOf(raw.candidateOutput, raw.candidateSchemaValid),
    })));
  }
  return { rows, coverage, users: resolvedUsers };
}
