import { z } from "zod";
import { evalTracks } from "./schema.js";

// One line of a dataset JSONL file. inputSnapshot/calcInputs are opaque to
// the Judge service — it never interprets or recomputes them, only forwards
// them verbatim to Cosmic Guidance's internal generation interface, which is
// the sole owner of the calculation logic and prompt builders.
export const datasetCaseSchema = z.object({
  caseKey: z.string().min(1),
  track: z.enum(evalTracks),
  promptVersion: z.string().min(1),
  inputSnapshot: z.record(z.unknown()),
  tags: z.array(z.string()).default([]),
  // Provenance note, required so every case is traceable to how its
  // deterministic values were sourced (never hand-invented).
  calcSource: z.enum(["cosmic_guidance_internal_api", "mock_fixture_for_local_dev", "canonical_registry"]),
  datasetVersion: z.string().min(1).optional(),
  numberType: z.string().min(1).optional(),
  numberValue: z.number().int().optional(),
  insightType: z.enum(["brief", "detailed"]).optional(),
  year: z.number().int().optional(),
  goldFacts: z.record(z.unknown()).optional(),
  expectedRootKey: z.enum(["brief_insight", "detailed_reading"]).optional(),
  masterNumber: z.boolean().optional(),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  schemaVersion: z.string().min(1).optional(),
  calculatorVersion: z.string().min(1).optional(),
  generationConfig: z.record(z.unknown()).optional(),
  provenance: z.record(z.unknown()).optional(),
  reviewStatus: z.string().min(1).optional(),
  goldOutput: z.record(z.unknown()).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reviewHistory: z.array(z.record(z.unknown())).optional(),
});
export type DatasetCase = z.infer<typeof datasetCaseSchema>;

export const datasetManifestSchema = z.object({
  track: z.enum(evalTracks),
  version: z.string().min(1),
  description: z.string().optional(),
});
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;
