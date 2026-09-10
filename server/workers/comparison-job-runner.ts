import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalComparisonRuns, evalDatasetCases, evalDatasetOutputs, evalDatasetSubjects, evalDeterministicResults, evalExperiments, evalGenerations, evalJobs, evalRows, evalRunManifests } from "../../shared/schema.js";
import { getConfigVersion } from "../config/config-service.js";
import { requestGeneration, type GenerationAttemptEvent } from "../services/generation-client.js";
import { logAudit } from "../services/audit-service.js";
import type { JudgeConfig } from "../../shared/config-schema.js";
import { finishLlmRequest, startLlmRequest } from "../services/llm-request-service.js";
import { loadBlockers, loadTrackSpecs } from "../core/config/loader.js";
import { resolveTrack } from "../adapters/cosmic-guidance/track-map.js";
import { rendererRegistry } from "../adapters/cosmic-guidance/renderer.js";
import { loadTrackPrompt } from "../adapters/cosmic-guidance/prompt.js";
import { judgeAndPersistRenderedPayload } from "../adapters/cosmic-guidance/evidence-judge.js";
import { runDeterministicChecks } from "../services/deterministic-checks.js";
import type { Row } from "../core/contracts/rendered-content.js";
import type { Renderer } from "../core/contracts/ports.js";
import type { TrackSpec } from "../core/config/schema.js";
import type { RenderedPayload } from "../core/pipeline/render.js";
import path from "node:path";
import { buildComparisonRunReport } from "../services/comparison-run-report.js";
import { getRunCostAnalysis } from "../services/cost-service.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../config");

export async function runComparisonJob(db: Db, jobId: string): Promise<void> {
  const [row] = await db
    .select({ job: evalJobs, comparison: evalExperiments, case: evalDatasetCases, current: evalDatasetOutputs, subjectKey: evalDatasetSubjects.subjectKey })
    .from(evalJobs)
    .innerJoin(evalExperiments, eq(evalExperiments.id, evalJobs.experimentId))
    .innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId))
    .leftJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
    .leftJoin(evalDatasetOutputs, and(eq(evalDatasetOutputs.caseId, evalDatasetCases.id), eq(evalDatasetOutputs.datasetId, evalDatasetCases.datasetId)))
    .where(eq(evalJobs.id, jobId));
  const runId = row?.job.runId;
  if (!runId) throw new Error(`comparison job ${jobId} is missing run_id`);
  if (row.job.status === "cancelled" || await isRunCancelled(db, runId)) {
    await markJobCancelled(db, jobId);
    return;
  }

  const [claimed] = await db.update(evalJobs).set({ status: "generating", attemptCount: row.job.attemptCount + 1, updatedAt: new Date() }).where(and(eq(evalJobs.id, jobId), inArray(evalJobs.status, ["pending", "queued"]))).returning({ id: evalJobs.id });
  if (!claimed) return;
  const attempt = row.job.attemptCount + 1;
  try {
    if (await isRunCancelled(db, runId)) {
      await markJobCancelled(db, jobId);
      return;
    }
    if (!row.current?.parsedOutput || !row.current.schemaValid) throw new Error(`dataset current reading is missing or invalid for case ${row.case.caseKey}`);
    const { value: config } = await getConfigVersion(db, row.comparison.configVersionId);
    const track = row.case.track === "numerology" ? "numerology" : row.case.track;
    const response = await requestGeneration({
      track,
      arm: "candidate",
      model: row.comparison.candidateModel,
      promptVersion: row.case.promptVersion,
      inputSnapshot: row.case.inputSnapshot as Record<string, unknown>,
      requestId: `${row.job.idempotencyKey}:candidate`,
    }, config.retryPolicy, {
      onAttemptStart: (event) => startGenerationAttempt(db, row.job.id, runId, event),
      onAttempt: (event, context) => finishGenerationAttempt(db, event, context),
    });

    if (await isRunCancelled(db, runId)) {
      await markJobCancelled(db, jobId);
      return;
    }

    await db.insert(evalGenerations).values([
      {
        jobId,
        arm: "baseline",
        executionMode: "cg_standard",
        provider: row.current.provider,
        model: row.current.model,
        promptVersion: row.current.promptVersion,
        parsedOutput: row.current.parsedOutput,
        rawOutput: row.current.rawOutput,
        schemaValid: row.current.schemaValid,
      },
      {
        jobId,
        arm: "candidate",
        executionMode: "cg_standard",
        provider: providerForModel(response.model, response.requestArtifact?.providerMetadata),
        model: response.model,
        promptVersion: response.promptVersion,
        parsedOutput: response.output,
        rawOutput: response.output,
        schemaValid: response.schemaValid,
        requestId: response.requestId,
        providerRequestId: response.requestArtifact?.requestLogId ?? null,
        endpoint: response.requestArtifact?.endpoint ?? null,
        systemPromptTokens: response.requestArtifact?.systemPromptTokens ?? null,
        userPromptTokens: response.requestArtifact?.userPromptTokens ?? null,
        assistantContextTokens: response.requestArtifact?.assistantContextTokens ?? null,
        promptCharacterCount: response.requestArtifact?.promptCharacterCount ?? null,
        tokenBreakdownSource: response.requestArtifact?.providerMetadata?.tokenBreakdownSource
          ? String(response.requestArtifact.providerMetadata.tokenBreakdownSource)
          : null,
        providerMetadata: { ...(response.requestArtifact?.providerMetadata ?? {}), calcOutputs: response.calcOutputs },
        promptHash: response.requestArtifact?.userPromptHash ?? null,
        responseCharacterCount: JSON.stringify(response.output).length,
        tokensPrompt: response.usage.promptTokens,
        tokensCompletion: response.usage.completionTokens,
        tokensTotal: response.usage.totalTokens,
        tokensCached: response.usage.cachedPromptTokens ?? null,
        tokensReasoning: response.usage.reasoningTokens ?? null,
        tokensAcceptedPrediction: response.usage.acceptedPredictionTokens ?? null,
        tokensRejectedPrediction: response.usage.rejectedPredictionTokens ?? null,
        latencyMs: response.latencyMs,
        costUsd: response.costUsd,
        attempt,
        costStatus: response.costUsd != null ? "known" : "unknown",
        costSource: response.costUsd != null ? "provider" : "none",
        error: response.error,
      },
    ]);
    await judgeComparisonJob(db, jobId, config);
    if (await isRunCancelled(db, runId)) {
      await markJobCancelled(db, jobId);
      return;
    }
    await db.update(evalJobs).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
    await refreshRunStatus(db, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await isRunCancelled(db, runId)) {
      await markJobCancelled(db, jobId);
      return;
    }
    await db.update(evalJobs).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
    await refreshRunStatus(db, runId);
    await logAudit(db, { eventName: "comparison.run.job_failed", actor: "comparison-worker", experimentId: row.comparison.id, jobId, metadata: { runId, error: message } });
    throw error;
  }
}

export async function judgeComparisonJob(db: Db, jobId: string, suppliedConfig?: JudgeConfig): Promise<void> {
  const [row] = await db
    .select({ job: evalJobs, comparison: evalExperiments, case: evalDatasetCases, subjectKey: evalDatasetSubjects.subjectKey })
    .from(evalJobs)
    .innerJoin(evalExperiments, eq(evalExperiments.id, evalJobs.experimentId))
    .innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId))
    .leftJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
    .where(eq(evalJobs.id, jobId));
  if (!row?.job.runId) throw new Error(`comparison job ${jobId} is missing run_id`);

  const generations = await db.select().from(evalGenerations).where(eq(evalGenerations.jobId, jobId));
  const baseline = generations.find((generation) => generation.arm === "baseline")?.parsedOutput;
  const candidate = generations.find((generation) => generation.arm === "candidate")?.parsedOutput;
  if (!baseline || !candidate || typeof baseline !== "object" || typeof candidate !== "object" || Array.isArray(baseline) || Array.isArray(candidate)) {
    throw new Error(`comparison job ${jobId} has no complete baseline and candidate readings to analyze`);
  }

  const config = suppliedConfig ?? (await getConfigVersion(db, row.comparison.configVersionId)).value;
  const tracks = loadTrackSpecs(CONFIG_DIR, loadBlockers(CONFIG_DIR));
  const resolved = resolveTrack(row.case.track, row.case.readingType, row.case.readingSubtype);
  const trackKey = resolved?.trackKey ?? (tracks.some((track) => track.track === row.case.track) ? row.case.track : null);
  const track = tracks.find((item) => item.track === trackKey && item.status === "active");
  if (!track || !resolved) throw new Error(`no active configured judge track for ${row.case.track}/${row.case.readingType}/${row.case.readingSubtype}`);
  const renderer = rendererRegistry([track]).get(track.track);
  if (!renderer) throw new Error(`no renderer configured for ${track.track}`);
  const userId = row.subjectKey ?? row.case.caseKey;
  const inputSnapshot = row.case.inputSnapshot as Record<string, unknown>;
  const baselineOutput = baseline as Record<string, unknown>;
  const candidateOutput = candidate as Record<string, unknown>;
  const baselineGeneration = generations.find((generation) => generation.arm === "baseline");
  const candidateGeneration = generations.find((generation) => generation.arm === "candidate");
  const secondaryEnabled = sampleSecondary(`${row.job.idempotencyKey}:secondary`, config.secondaryJudgeSampleRate);

  await db.update(evalJobs).set({ status: "judging", updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
  const arms = [
    { arm: "baseline" as const, output: baselineOutput, generation: baselineGeneration },
    { arm: "candidate" as const, output: candidateOutput, generation: candidateGeneration },
  ];
  for (const item of arms) {
    const calcOutputs = item.generation?.providerMetadata && typeof item.generation.providerMetadata === "object" && !Array.isArray(item.generation.providerMetadata) && typeof (item.generation.providerMetadata as Record<string, unknown>).calcOutputs === "object" && (item.generation.providerMetadata as Record<string, unknown>).calcOutputs !== null ? (item.generation.providerMetadata as Record<string, unknown>).calcOutputs as Record<string, unknown> : null;
    await persistDeterministicChecks(db, jobId, item.arm, row.case.track, row.case.schemaVersion, inputSnapshot, calcOutputs, item.output, item.generation?.schemaValid ?? false, item.generation?.error ? [item.generation.error] : []);
    const primary = await judgeOneArm(db, row.job.runId, row.job.id, userId, track, renderer, item.arm, item.output, item.generation, inputSnapshot, config.providers.primary_judge, "primary");
    if (primary.status !== "ok") throw new Error(`primary judge ${primary.status} for ${item.arm}: ${primary.issues?.map((issue) => issue.message).join("; ") ?? "no valid response"}`);
    if (await isRunCancelled(db, row.job.runId)) return;
    if (secondaryEnabled) {
      const secondary = await judgeOneArm(db, row.job.runId, row.job.id, userId, track, renderer, item.arm, item.output, item.generation, inputSnapshot, config.providers.secondary_judge, "secondary");
      if (secondary.status !== "ok") {
        await logAudit(db, { eventName: "comparison.run.secondary_judge_failed", actor: "comparison-worker", experimentId: row.comparison.id, jobId, metadata: { runId: row.job.runId, arm: item.arm, status: secondary.status, issues: secondary.issues } });
      }
    }
  }
}

async function persistDeterministicChecks(db: Db, jobId: string, arm: "baseline" | "candidate", track: string, schemaVersion: string | null, inputSnapshot: Record<string, unknown>, calcOutputs: Record<string, unknown> | null, output: Record<string, unknown>, schemaValid: boolean, schemaErrors: string[]): Promise<void> {
  const result = runDeterministicChecks({ track, schemaValid, schemaErrors, inputSnapshot, calcOutputs, output });
  await db.delete(evalDeterministicResults).where(and(eq(evalDeterministicResults.jobId, jobId), eq(evalDeterministicResults.arm, arm)));
  await db.insert(evalDeterministicResults).values(result.map((item) => ({ jobId, arm, checkName: item.checkName, passed: item.passed, detail: item.detail ?? (schemaVersion ? `schema=${schemaVersion}` : null) })));
}

async function judgeOneArm(
  db: Db,
  runId: string,
  jobId: string,
  userId: string,
  track: TrackSpec,
  renderer: Renderer,
  arm: "baseline" | "candidate",
  output: Record<string, unknown>,
  generation: typeof evalGenerations.$inferSelect | undefined,
  inputSnapshot: Record<string, unknown>,
  binding: JudgeConfig["providers"]["primary_judge"],
  judgeRole: "primary" | "secondary",
) {
  const rowId = `comparison:${jobId}:${arm}:${judgeRole}`;
  const generationUsage = (generation?.providerMetadata ?? null) as Record<string, unknown> | null;
  const row: Row = {
    rowId,
    runId,
    userId,
    track: track.track,
    stratum: {},
    modelRef: arm,
    inputSnapshot,
    candidateOutput: output,
    silverOutput: null,
    generation: { inputTokens: generation?.tokensPrompt ?? 0, outputTokens: generation?.tokensCompletion ?? 0, latencyMs: generation?.latencyMs ?? 0 },
    loadStatus: "ok",
    provenance: {},
  };
  await db.insert(evalRows).values(row).onConflictDoNothing();
  const raw = { userId, track: track.track, stratum: {}, inputSnapshot, candidateOutput: output, candidateSchemaValid: generation?.schemaValid ?? false, silverOutput: null, generation: row.generation };
  const payload: RenderedPayload = { rowId, runId, userId, track: track.track, stratum: {}, modelRef: arm, content: renderer.render(raw) };
  const prompt = await loadTrackPrompt(track, payload);
  return judgeAndPersistRenderedPayload(payload, prompt, binding, "high", { db, jobId, runId, judgeRole, requestId: `${runId}:${jobId}:${arm}:${judgeRole}` });
}

async function startGenerationAttempt(db: Db, jobId: string, runId: string, event: { attempt: number; requestId: string; model: string; endpoint: string; startedAt: Date }): Promise<string> {
  return startLlmRequest(db, {
    jobId,
    runId,
    requestKind: "generation",
    requestId: event.requestId,
    attempt: event.attempt,
    provider: providerForModel(event.model, null),
    model: event.model,
    endpoint: event.endpoint,
    startedAt: event.startedAt,
  });
}

async function finishGenerationAttempt(db: Db, event: GenerationAttemptEvent, context: unknown): Promise<void> {
  if (typeof context !== "string") throw new Error("generation telemetry context was not created");
  const artifact = event.response?.requestArtifact;
  if (event.response && event.response.usage.promptTokens > 0 && !artifact) {
    const error = "generation response omitted the provider request artifact; usage cannot be audited";
    await finishLlmRequest(db, context, {
      status: "failed",
      completedAt: event.completedAt,
      latencyMs: event.latencyMs,
      tokensPrompt: event.response.usage.promptTokens,
      tokensCompletion: event.response.usage.completionTokens,
      tokensTotal: event.response.usage.totalTokens,
      tokensCached: event.response.usage.cachedPromptTokens ?? null,
      tokensReasoning: event.response.usage.reasoningTokens ?? null,
      tokensAcceptedPrediction: event.response.usage.acceptedPredictionTokens ?? null,
      tokensRejectedPrediction: event.response.usage.rejectedPredictionTokens ?? null,
      error,
      costStatus: "unknown",
      costSource: "none",
    });
    throw new Error(error);
  }
  await finishLlmRequest(db, context, {
    status: event.status,
    completedAt: event.completedAt,
    latencyMs: event.latencyMs,
    tokensPrompt: event.response?.usage.promptTokens,
    tokensCompletion: event.response?.usage.completionTokens,
    tokensTotal: event.response?.usage.totalTokens,
    tokensCached: event.response?.usage.cachedPromptTokens ?? null,
    tokensReasoning: event.response?.usage.reasoningTokens ?? null,
    tokensAcceptedPrediction: event.response?.usage.acceptedPredictionTokens ?? null,
    tokensRejectedPrediction: event.response?.usage.rejectedPredictionTokens ?? null,
    systemPromptTokens: artifact?.systemPromptTokens,
    userPromptTokens: artifact?.userPromptTokens,
    assistantContextTokens: artifact?.assistantContextTokens,
    promptCharacterCount: artifact?.promptCharacterCount,
    tokenBreakdownSource: typeof artifact?.providerMetadata?.tokenBreakdownSource === "string" ? artifact.providerMetadata.tokenBreakdownSource : null,
    costUsd: event.response?.costUsd,
    costStatus: event.response?.costUsd != null ? "known" : "unknown",
    costSource: event.response?.costUsd != null ? "provider" : "none",
    providerMetadata: artifact?.providerMetadata ?? null,
    error: event.error ?? event.response?.error ?? null,
  });
}

function sampleSecondary(key: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 0xffffffff < rate;
}

function providerForModel(model: string, metadata: Record<string, unknown> | null | undefined): string {
  const declared = metadata?.provider;
  if (typeof declared === "string" && declared.trim()) return declared;
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("gpt-") || normalized.startsWith("o3") || normalized.startsWith("o4")) return "openai";
  throw new Error(`candidate model "${model}" has no official provider mapping; refuse to record an unpriced provider`);
}

export async function refreshRunStatus(db: Db, runId: string): Promise<void> {
  const [run] = await db.select({ status: evalComparisonRuns.status }).from(evalComparisonRuns).where(eq(evalComparisonRuns.id, runId));
  if (!run || run.status === "cancelled") return;
  const jobs = await db.select({ status: evalJobs.status }).from(evalJobs).where(eq(evalJobs.runId, runId));
  const completedCases = jobs.filter((job) => job.status === "completed").length;
  const failedCases = jobs.filter((job) => job.status === "failed").length;
  const finished = jobs.length > 0 && completedCases + failedCases === jobs.length;
  await db.update(evalComparisonRuns).set({
    status: finished ? (failedCases ? "failed" : "completed") : "running",
    completedCases,
    failedCases,
    ...(finished ? { completedAt: new Date() } : {}),
  }).where(and(eq(evalComparisonRuns.id, runId), ne(evalComparisonRuns.status, "cancelled")));
  if (finished) await finalizeRunArtifacts(db, runId);
}

async function finalizeRunArtifacts(db: Db, runId: string): Promise<void> {
  const [run] = await db.select({ status: evalComparisonRuns.status }).from(evalComparisonRuns).where(eq(evalComparisonRuns.id, runId));
  if (!run || (run.status !== "completed" && run.status !== "failed")) return;
  try {
    const [report, cost] = await Promise.all([buildComparisonRunReport(db, runId), getRunCostAnalysis(db, runId)]);
    await db.update(evalRunManifests).set({ reportSnapshot: { report, cost }, status: run.status === "completed" ? "finalized" : "partial", finalizedAt: new Date() }).where(eq(evalRunManifests.runId, runId));
  } catch (error) {
    await logAudit(db, { eventName: "comparison.run.finalization_failed", actor: "comparison-worker", metadata: { runId, error: error instanceof Error ? error.message : String(error) } });
  }
}

async function isRunCancelled(db: Db, runId: string): Promise<boolean> {
  const [run] = await db.select({ status: evalComparisonRuns.status }).from(evalComparisonRuns).where(eq(evalComparisonRuns.id, runId));
  return run?.status === "cancelled";
}

async function markJobCancelled(db: Db, jobId: string): Promise<void> {
  const now = new Date();
  await db.update(evalJobs).set({ status: "cancelled", lastError: "Cancelled by operator", completedAt: now, updatedAt: now }).where(eq(evalJobs.id, jobId));
}
