import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalDatasets, evalDatasetCases } from "../../shared/schema.js";
import { datasetCaseSchema, datasetManifestSchema, type DatasetCase } from "../../shared/dataset-types.js";
import { logAudit } from "./audit-service.js";

const DATASETS_ROOT = path.resolve(process.cwd(), "datasets");

export function datasetFilePath(track: string, version: string): string {
  return path.join(DATASETS_ROOT, track, version, "cases.jsonl");
}

export async function loadDatasetFile(track: string, version: string): Promise<DatasetCase[]> {
  const raw = await readFile(datasetFilePath(track, version), "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`${track}/${version}/cases.jsonl:${i + 1} is not valid JSON: ${String(err)}`);
    }
    const result = datasetCaseSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${track}/${version}/cases.jsonl:${i + 1} failed schema validation: ${result.error.message}`);
    }
    if (result.data.track !== track) {
      throw new Error(`${track}/${version}/cases.jsonl:${i + 1} declares track "${result.data.track}", expected "${track}"`);
    }
    return result.data;
  });
}

export function checksumCases(cases: DatasetCase[]): string {
  const hash = crypto.createHash("sha256");
  for (const c of cases) hash.update(JSON.stringify(c));
  return hash.digest("hex");
}

/** Registers (or re-validates) a versioned dataset file into the DB. Idempotent: re-registering the same track+version with unchanged content is a no-op; changed content requires bumping the version, never overwriting one in place. */
export async function registerDataset(
  db: Db,
  params: { track: string; version: string; description?: string; createdBy: string },
): Promise<{ datasetId: string; caseCount: number }> {
  const cases = await loadDatasetFile(params.track, params.version);
  if (cases.length === 0) throw new Error(`Dataset ${params.track}/${params.version} has zero cases.`);
  datasetManifestSchema.parse({ track: params.track, version: params.version, description: params.description });

  const checksum = checksumCases(cases);
  const [existing] = await db
    .select()
    .from(evalDatasets)
    .where(and(eq(evalDatasets.track, params.track), eq(evalDatasets.version, params.version)));

  if (existing) {
    if (existing.sourceChecksum !== checksum) {
      throw new Error(
        `Dataset ${params.track}/${params.version} is already registered with different content. ` +
        `Datasets are immutable once registered — publish a new version instead (e.g. v2).`,
      );
    }
    return { datasetId: existing.id, caseCount: existing.caseCount };
  }

  return db.transaction(async (tx) => {
    const [dataset] = await tx
      .insert(evalDatasets)
      .values({
        track: params.track,
        version: params.version,
        description: params.description,
        sourceChecksum: checksum,
        caseCount: cases.length,
        createdBy: params.createdBy,
      })
      .returning();

    await tx.insert(evalDatasetCases).values(
      cases.map((c) => ({
        datasetId: dataset.id,
        caseKey: c.caseKey,
        track: c.track,
        inputSnapshot: c.inputSnapshot,
        promptVersion: c.promptVersion,
        tags: c.tags,
      })),
    );

    await logAudit(tx as unknown as Db, {
      eventName: "dataset.registered",
      actor: params.createdBy,
      datasetId: dataset.id,
      metadata: { track: params.track, version: params.version, caseCount: cases.length, checksum },
    });

    return { datasetId: dataset.id, caseCount: cases.length };
  });
}
