import type { RawRow, Renderer } from "../contracts/ports.js";
import type { Row } from "../contracts/rendered-content.js";

export type RenderedPayload = {
  rowId: string;
  runId: string;
  userId: string;
  track: string;
  stratum: Row["stratum"];
  modelRef: string;
  content: ReturnType<Renderer["render"]>;
};

/**
 * Stage 2 orchestration. The renderer registry is injected by an adapter;
 * core never knows a product's track names or output shapes.
 */
export function renderRows(rows: Row[], renderers: ReadonlyMap<string, Renderer>): RenderedPayload[] {
  return rows
    .filter((row) => row.loadStatus === "ok")
    .map((row) => {
      const renderer = renderers.get(row.track);
      if (!renderer) throw new Error(`No renderer registered for track "${row.track}"`);
      const raw: RawRow = {
        userId: row.userId,
        track: row.track,
        stratum: row.stratum,
        inputSnapshot: row.inputSnapshot,
        candidateOutput: row.candidateOutput,
        candidateSchemaValid: row.loadStatus === "ok",
        silverOutput: row.silverOutput,
        generation: row.generation,
      };
      return {
        rowId: row.rowId,
        runId: row.runId,
        userId: row.userId,
        track: row.track,
        stratum: row.stratum,
        modelRef: row.modelRef,
        content: renderer.render(raw),
      };
    });
}
