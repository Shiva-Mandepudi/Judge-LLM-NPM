import type { DeterministicCheckResult } from "./deterministic-checks.js";
import type { JudgeOutput } from "./judge-client.js";

export interface HardFailure {
  source: "deterministic" | "judge";
  label?: string;
  checkOrDimension: string;
  detail: string | null;
}

export function collectHardFailures(deterministic: DeterministicCheckResult[], judgeOutputs: JudgeOutput[]): HardFailure[] {
  const failures: HardFailure[] = [];
  for (const r of deterministic) {
    if (!r.passed) failures.push({ source: "deterministic", checkOrDimension: r.checkName, detail: r.detail ?? null });
  }
  for (const output of judgeOutputs) {
    for (const [label, gates] of Object.entries(output.hardGateResults)) {
      for (const [dimension, result] of Object.entries(gates)) {
        if (!result.pass) failures.push({ source: "judge", label, checkOrDimension: dimension, detail: result.violationDetail });
      }
    }
  }
  return failures;
}
