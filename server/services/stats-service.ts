import type { BlindLabelMap } from "./blind-ab-service.js";
import { armForLabel, labelForArm } from "./blind-ab-service.js";
import type { JudgeOutput } from "./judge-client.js";
import { computeDimensionAgreement, agreementRate } from "./agreement-service.js";

export interface JobStatsInput {
  blindLabelMap: BlindLabelMap;
  primaryOutput: JudgeOutput;
  secondaryOutput?: JudgeOutput;
  hardFailureCount: number;
  tags: string[];
}

export interface ExperimentStats {
  sampleSize: number;
  meanDimensionScores: { baseline: Record<string, number>; candidate: Record<string, number> };
  dimensionDeltas: Record<string, number>; // candidate - baseline, per dimension
  winRate: number;
  tieRate: number;
  lossRate: number;
  hardGateFailureCount: number;
  judgeAgreementRate: number | null; // null if no secondary-judge samples in this batch
}

export function computeExperimentStats(jobs: JobStatsInput[]): ExperimentStats {
  const dimensionSums: { baseline: Record<string, number[]>; candidate: Record<string, number[]> } = { baseline: {}, candidate: {} };
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let hardGateFailureCount = 0;
  const agreementRates: number[] = [];

  for (const job of jobs) {
    hardGateFailureCount += job.hardFailureCount;

    for (const [label, dims] of Object.entries(job.primaryOutput.dimensionScores)) {
      const arm = armForLabel(job.blindLabelMap, label as "A" | "B");
      for (const [dimension, { score }] of Object.entries(dims)) {
        (dimensionSums[arm][dimension] ??= []).push(score);
      }
    }

    if (job.primaryOutput.pairwiseWinner) {
      const winnerArm = job.primaryOutput.pairwiseWinner === "Tie" ? "Tie" : armForLabel(job.blindLabelMap, job.primaryOutput.pairwiseWinner);
      if (winnerArm === "Tie") ties++;
      else if (winnerArm === "candidate") wins++;
      else losses++;
    }

    if (job.secondaryOutput) {
      const agreements = computeDimensionAgreement(job.primaryOutput, job.secondaryOutput);
      agreementRates.push(agreementRate(agreements));
    }
  }

  const mean = (values: number[] | undefined) => (values && values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
  const meanDimensionScores = {
    baseline: Object.fromEntries(Object.entries(dimensionSums.baseline).map(([d, v]) => [d, mean(v)])),
    candidate: Object.fromEntries(Object.entries(dimensionSums.candidate).map(([d, v]) => [d, mean(v)])),
  };
  const dimensionDeltas = Object.fromEntries(
    Object.keys(meanDimensionScores.candidate).map((d) => [d, meanDimensionScores.candidate[d] - meanDimensionScores.baseline[d]]),
  );

  const decided = wins + ties + losses;
  return {
    sampleSize: jobs.length,
    meanDimensionScores,
    dimensionDeltas,
    winRate: decided > 0 ? wins / decided : 0,
    tieRate: decided > 0 ? ties / decided : 0,
    lossRate: decided > 0 ? losses / decided : 0,
    hardGateFailureCount,
    judgeAgreementRate: agreementRates.length > 0 ? agreementRates.reduce((a, b) => a + b, 0) / agreementRates.length : null,
  };
}

// exported for callers that need to translate a blind label back for display/audit purposes
export { labelForArm };
