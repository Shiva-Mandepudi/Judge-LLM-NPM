import type { JudgeConfig } from "./config-schema.js";

// Enforces judge-llm-evaluation-framework.md §2.1 "Model selection and
// anti-bias design": the judge must never be the same model (or same family)
// as a candidate being judged — this app's candidates are gpt-4o/gpt-4o-mini,
// so those families are never valid judge models. Primary/secondary should
// also come from different vendor families so the 20% cross-vendor
// subsample (§6.1) actually triangulates instead of comparing a model to
// itself. "mock" is exempt — it's the local-dev/test double, not a real judge.
const BANNED_JUDGE_MODEL_PREFIXES = ["gpt-4o", "gpt-3.5", "gpt-4-turbo", "gpt-4o-mini"];

export function validateJudgeIndependence(config: JudgeConfig): string[] {
  const problems: string[] = [];
  const { primary_judge, secondary_judge } = config.providers;

  for (const [role, binding] of [["primary_judge", primary_judge], ["secondary_judge", secondary_judge]] as const) {
    if (binding.provider === "mock" || binding.provider === "unset") continue;
    const model = binding.model.toLowerCase();
    if (BANNED_JUDGE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
      problems.push(
        `${role} is set to "${binding.model}", which is one of this app's own candidate model families. ` +
          `Using it as a judge violates the anti-self-preference-bias rule (framework §2.1) — choose a ` +
          `frontier reasoning model that isn't gpt-4o/gpt-4o-mini/gpt-3.5/gpt-4-turbo.`,
      );
    }
  }

  const bothReal = primary_judge.provider !== "mock" && primary_judge.provider !== "unset" && secondary_judge.provider !== "mock" && secondary_judge.provider !== "unset";
  if (bothReal && primary_judge.provider === secondary_judge.provider) {
    problems.push(
      `primary_judge and secondary_judge are both on provider "${primary_judge.provider}". ` +
        `Cross-vendor triangulation (framework §2.1) requires the secondary judge to be a different vendor family, ` +
        `otherwise the 20% cross-vendor subsample can't detect vendor-specific rubric bias.`,
    );
  }

  return problems;
}
