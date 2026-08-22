import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalJobs, evalGenerations, evalDeterministicResults, evalJudgeScores, evalExperiments, evalDatasetCases } from "../../shared/schema.js";
import type { EvalTrack } from "../../shared/schema.js";
import { getActiveConfig } from "../config/config-service.js";
import { requestGeneration } from "../services/generation-client.js";
import { runDeterministicChecks, hasDeterministicHardFailure } from "../services/deterministic-checks.js";
import { assignBlindLabels, armForLabel, type Arm } from "../services/blind-ab-service.js";
import { callJudge } from "../services/judge-client.js";
import { collectHardFailures } from "../services/scoring-service.js";
import { computeDimensionAgreement } from "../services/agreement-service.js";
import { enqueueHumanReview } from "../services/human-review-service.js";
import { logAudit } from "../services/audit-service.js";
import { logger } from "../lib/logger.js";
import type { GenerationRequest } from "../../shared/contract.js";

/**
 * Runs exactly one evaluation job end to end: generate baseline + candidate
 * via Cosmic Guidance's internal interface, run deterministic checks, call
 * the primary judge (and secondary, if sampled), persist every artifact, and
 * mark the job completed/failed. Invoked by the Cloud Tasks push handler —
 * never inline with a normal user request.
 */
export async function runJob(db: Db, jobId: string): Promise<void> {
  const [job] = await db.select().from(evalJobs).where(eq(evalJobs.id, jobId));
  if (!job) throw new Error(`Job ${jobId} not found`);

  const [experiment] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, job.experimentId));
  if (!experiment) throw new Error(`Experiment ${job.experimentId} not found`);

  const [datasetCase] = await db.select().from(evalDatasetCases).where(eq(evalDatasetCases.id, job.caseId));
  if (!datasetCase) throw new Error(`Dataset case ${job.caseId} not found`);

  await db.update(evalJobs).set({ status: "generating", attemptCount: job.attemptCount + 1, updatedAt: new Date() }).where(eq(evalJobs.id, jobId));

  try {
    const { value: config, id: configVersionId } = await getActiveConfig(db, "global");
    const track = experiment.track as EvalTrack;

    const blindLabelMap = job.blindLabelMap ?? assignBlindLabels(job.idempotencyKey);

    const arms: Array<{ arm: Arm; model: string; promptVersion: string }> = [
      { arm: "baseline", model: experiment.baselineModel, promptVersion: experiment.baselinePromptVersion },
      { arm: "candidate", model: experiment.candidateModel, promptVersion: experiment.candidatePromptVersion },
    ];

    const generations = await Promise.all(
      arms.map(async ({ arm, model, promptVersion }) => {
        const request: GenerationRequest = {
          track,
          arm,
          model,
          promptVersion,
          inputSnapshot: datasetCase.inputSnapshot as Record<string, unknown>,
          requestId: `${job.idempotencyKey}:${arm}`,
        };
        const response = await requestGeneration(request, config.retryPolicy);
        return { arm, response };
      }),
    );

    await db.update(evalJobs).set({ status: "checking", blindLabelMap, updatedAt: new Date() }).where(eq(evalJobs.id, jobId));

    for (const { arm, response } of generations) {
      await db.insert(evalGenerations).values({
        jobId,
        arm,
        provider: "cosmic_guidance",
        model: response.model,
        promptVersion: response.promptVersion,
        rawOutput: response.output,
        parsedOutput: response.output,
        schemaValid: response.schemaValid,
        tokensPrompt: response.usage.promptTokens,
        tokensCompletion: response.usage.completionTokens,
        latencyMs: response.latencyMs,
        costUsd: response.costUsd,
        error: response.error,
      });
    }

    const deterministicByArm = new Map<Arm, ReturnType<typeof runDeterministicChecks>>();
    for (const { arm, response } of generations) {
      const results = runDeterministicChecks({
        track,
        schemaValid: response.schemaValid,
        schemaErrors: response.schemaErrors,
        inputSnapshot: datasetCase.inputSnapshot as Record<string, unknown>,
        calcOutputs: response.calcOutputs,
        output: response.output,
      });
      deterministicByArm.set(arm, results);
      await db.insert(evalDeterministicResults).values(results.map((r) => ({ jobId, arm, checkName: r.checkName, passed: r.passed, detail: r.detail })));
    }

    const allDeterministic = [...deterministicByArm.values()].flat();
    const deterministicHardFailed = hasDeterministicHardFailure(allDeterministic);

    await db.update(evalJobs).set({ status: "judging", updatedAt: new Date() }).where(eq(evalJobs.id, jobId));

    const responseByArm = new Map(generations.map((g) => [g.arm, g.response.output]));
    const calcOutputs = generations.find((g) => g.response.calcOutputs)?.response.calcOutputs ?? null;

    const promptInputBase = {
      track,
      inputSnapshot: datasetCase.inputSnapshot as Record<string, unknown>,
      calcOutputs,
      responseA: responseByArm.get(armForLabel(blindLabelMap, "A"))!,
      responseB: responseByArm.get(armForLabel(blindLabelMap, "B"))!,
    };

    const primaryResult = await callJudge("primary_judge", config, promptInputBase);
    await persistJudgeScore(db, jobId, "primary", primaryResult);

    const sampleSecondary = deterministicSample(job.idempotencyKey, config.secondaryJudgeSampleRate);
    let secondaryResult: typeof primaryResult | undefined;
    if (sampleSecondary) {
      secondaryResult = await callJudge("secondary_judge", config, promptInputBase);
      await persistJudgeScore(db, jobId, "secondary", secondaryResult);
    }

    const judgeHardFailures = collectHardFailures(allDeterministic, [primaryResult.output, ...(secondaryResult ? [secondaryResult.output] : [])]);
    const hardFailed = deterministicHardFailed || judgeHardFailures.length > 0;

    if (hardFailed && config.humanReviewTriggers.onHardGateFailure) {
      await enqueueHumanReview(db, { jobId, experimentId: experiment.id, reason: "hard_gate_failure" });
    }
    if (primaryResult.output.confidence.level === "low" && config.humanReviewTriggers.onLowConfidence) {
      await enqueueHumanReview(db, { jobId, experimentId: experiment.id, reason: "low_confidence" });
    }
    if (secondaryResult) {
      const agreements = computeDimensionAgreement(primaryResult.output, secondaryResult.output);
      const disagreementRate = agreements.length > 0 ? agreements.filter((a) => !a.agree).length / agreements.length : 0;
      if (disagreementRate > 1 - config.thresholds.minJudgeAgreementRate && config.humanReviewTriggers.onJudgeDisagreement) {
        await enqueueHumanReview(db, { jobId, experimentId: experiment.id, reason: "judge_disagreement" });
      }
    }

    await db.update(evalJobs).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
    await logAudit(db, {
      eventName: "job.completed",
      actor: "job-runner",
      experimentId: experiment.id,
      jobId,
      promptVersion: experiment.candidatePromptVersion,
      model: experiment.candidateModel,
      configVersionId,
      metadata: { hardFailed, sampledSecondary: sampleSecondary },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("job_failed", { jobId, error: message });
    await db.update(evalJobs).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(evalJobs.id, jobId));
    throw err;
  }
}

async function persistJudgeScore(db: Db, jobId: string, role: "primary" | "secondary", result: Awaited<ReturnType<typeof callJudge>>) {
  await db.insert(evalJudgeScores).values({
    jobId,
    judgeRole: role,
    provider: result.provider,
    model: result.model,
    rubricVersion: result.rubricVersion,
    dimensionScores: result.output.dimensionScores,
    hardGateResults: result.output.hardGateResults,
    pairwiseWinner: result.output.pairwiseWinner ?? null,
    rationale: result.output.rationale,
    confidenceLevel: result.output.confidence.level,
    rawResponse: result.output,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
  });
}

// Deterministic (not Math.random) so the same job always samples the same
// way across retries/reruns — reproducibility matters more than true
// randomness here, and the hash is already uniformly distributed.
function deterministicSample(key: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const hash = crypto.createHash("sha256").update(`secondary-sample:${key}`).digest();
  const value = hash.readUInt32BE(0) / 0xffffffff;
  return value < rate;
}
