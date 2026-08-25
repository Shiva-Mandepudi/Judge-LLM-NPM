import type { JudgeOutput } from "./judge-client.js";

export interface DimensionAgreement {
  label: string;
  dimension: string;
  primaryScore: number;
  secondaryScore: number;
  agree: boolean;
}

// Historical rows used 1-5 aspect scores. New rows agree on the overall
// winner/tie decision and hard-gate results instead.
const AGREEMENT_TOLERANCE = 1;

export function computeDimensionAgreement(primary: JudgeOutput, secondary: JudgeOutput): DimensionAgreement[] {
  if (Object.keys(primary.dimensionScores).length === 0 || Object.keys(secondary.dimensionScores).length === 0) {
    return [{
      label: "overall",
      dimension: "overall",
      primaryScore: 0,
      secondaryScore: 0,
      agree: primary.pairwiseWinner === secondary.pairwiseWinner && JSON.stringify(primary.hardGateResults) === JSON.stringify(secondary.hardGateResults),
    }];
  }

  const labels = Object.keys(primary.dimensionScores).filter((l) => l in secondary.dimensionScores);
  const agreements: DimensionAgreement[] = [];
  for (const label of labels) {
    const dims = Object.keys(primary.dimensionScores[label]).filter((d) => d in secondary.dimensionScores[label]);
    for (const dimension of dims) {
      const primaryScore = primary.dimensionScores[label][dimension].score;
      const secondaryScore = secondary.dimensionScores[label][dimension].score;
      agreements.push({ label, dimension, primaryScore, secondaryScore, agree: Math.abs(primaryScore - secondaryScore) <= AGREEMENT_TOLERANCE });
    }
  }
  return agreements;
}

export function agreementRate(agreements: DimensionAgreement[]): number {
  if (agreements.length === 0) return 1;
  return agreements.filter((a) => a.agree).length / agreements.length;
}
