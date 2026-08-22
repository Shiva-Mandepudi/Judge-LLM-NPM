import type { JudgeOutput } from "./judge-client.js";

export interface DimensionAgreement {
  label: string;
  dimension: string;
  primaryScore: number;
  secondaryScore: number;
  agree: boolean;
}

// Agreement = scores within 1 point on the 1-5 scale (the framework treats
// exact-match-only as too strict for a 5-point scale used across two
// independently-prompted models). This is what "agreement" *means*, not a
// tunable business threshold, so it's a named constant rather than config.
const AGREEMENT_TOLERANCE = 1;

export function computeDimensionAgreement(primary: JudgeOutput, secondary: JudgeOutput): DimensionAgreement[] {
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
