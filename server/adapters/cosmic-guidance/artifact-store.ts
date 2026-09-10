import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import type { Db } from "../../db.js";
import { evalJudgementsV2, evalModelMap, evalRows, evalRunManifests } from "../../../shared/schema.js";
import type { Row } from "../../core/contracts/rendered-content.js";
import type { JudgeRun } from "../../core/judge/runner.js";

type Manifest = {
  configSnapshot: unknown;
  promptHashes: unknown;
  gitSha: string | null;
  bootstrapSeed: string;
  status: string;
};

export async function persistPhase0Artifacts(
  runId: string,
  rows: readonly Row[],
  modelRef: string,
  model: string,
  modelMapHash: string,
  manifest: Manifest,
): Promise<void> {
  const existingMap = await db
    .select({ model: evalModelMap.model, contentHash: evalModelMap.contentHash })
    .from(evalModelMap)
    .where(and(eq(evalModelMap.runId, runId), eq(evalModelMap.modelRef, modelRef)));
  if (existingMap[0] && existingMap[0].model !== model) {
    throw new Error(`sealed model map already exists with different contents for ${runId}/${modelRef}`);
  }

  await db.insert(evalModelMap).values({
    runId,
    modelRef,
    model,
    contentHash: modelMapHash,
  }).onConflictDoNothing();

  if (rows.length > 0) {
    await db.insert(evalRows).values(rows.map((row) => ({
      rowId: row.rowId,
      runId: row.runId,
      userId: row.userId,
      track: row.track,
      stratum: row.stratum,
      modelRef: row.modelRef,
      inputSnapshot: row.inputSnapshot,
      candidateOutput: row.candidateOutput,
      silverOutput: row.silverOutput,
      generation: row.generation,
      loadStatus: row.loadStatus,
      provenance: row.provenance,
    }))).onConflictDoNothing();
  }

  const persistedRows = await db
    .select({ rowId: evalRows.rowId })
    .from(evalRows)
    .where(eq(evalRows.runId, runId));
  if (persistedRows.length < rows.length) {
    throw new Error(`eval_rows persistence incomplete for ${runId}: ${persistedRows.length}/${rows.length}`);
  }

  await db.insert(evalRunManifests).values({
    runId,
    configSnapshot: manifest.configSnapshot,
    promptHashes: manifest.promptHashes,
    gitSha: manifest.gitSha,
    bootstrapSeed: manifest.bootstrapSeed,
    status: manifest.status,
  }).onConflictDoNothing();
}

export async function persistJudgeResult(input: {
  db: Db;
  rowId: string;
  runId: string;
  jobId: string | null;
  track: string;
  userId: string;
  modelRef: string;
  judgeRole: "primary" | "secondary";
  judgeProvider: string;
  judgeModel: string;
  judgeEffort: string;
  kernelHash: string;
  rubricPackHash: string;
  schemaHash: string;
  result: JudgeRun;
}): Promise<void> {
  await input.db.insert(evalJudgementsV2).values({
    rowId: input.rowId,
    runId: input.runId,
    jobId: input.jobId,
    track: input.track,
    userId: input.userId,
    modelRef: input.modelRef,
    judgeRole: input.judgeRole,
    judgeProvider: input.judgeProvider,
    judgeModel: input.judgeModel,
    judgeEffort: input.judgeEffort,
    kernelHash: input.kernelHash,
    rubricPackHash: input.rubricPackHash,
    schemaHash: input.schemaHash,
    usage: input.result.usage,
    latencyMs: input.result.latencyMs,
    costUsd: input.result.costUsd,
    judgeStatus: input.result.status,
    attempt: input.result.attempts,
    response: { validated: input.result.response ?? null, raw: input.result.raw ?? null },
  }).onConflictDoUpdate({
    target: [evalJudgementsV2.rowId, evalJudgementsV2.attempt],
    set: {
      jobId: input.jobId,
      track: input.track,
      userId: input.userId,
      modelRef: input.modelRef,
      judgeRole: input.judgeRole,
      judgeProvider: input.judgeProvider,
      judgeModel: input.judgeModel,
      judgeEffort: input.judgeEffort,
      kernelHash: input.kernelHash,
      rubricPackHash: input.rubricPackHash,
      schemaHash: input.schemaHash,
      usage: input.result.usage,
      latencyMs: input.result.latencyMs,
      costUsd: input.result.costUsd,
      judgeStatus: input.result.status,
      response: { validated: input.result.response ?? null, raw: input.result.raw ?? null },
    },
  });
}
