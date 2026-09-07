# Build Phases

Ordered by **cost of iteration**, not by product importance. The rubric, the harness and the
statistics all need several revisions before they are trustworthy, and revising them against
`natal_detailed` at ~$0.14 per judge call is the expensive way to learn. So the cheap,
strictly-validated, finite-input track goes first and the four big chart tracks go last —
by which time the instrument is stable.

Every phase has an exit gate. A phase is not done because the code runs.

## Prerequisites (outside this repo)

Not blockers for Phase 0, but each blocks a specific later phase.

| # | Item | Blocks |
|---|---|---|
| P1 | **Silver and challenger tables exist**, with per-track output columns and a user key. No such table exists in `shared/schema.ts` today — the datasource contract in [00-architecture](00-architecture-and-parametrization.md#configtrackstrackyaml) must be reconciled against the real schema once created. | Phase 1 |
| P2 | **Champion's exact model ID.** Recorded as `5.6 sol`; needs the provider's real identifier in `models.yaml`. | Phase 2 |
| P3 | **Champion's model family confirmed**, so the judge can be chosen from a different family. If the judge shares a family with the champion or the silver generator, self-preference bias lands on the incumbent and the sweep is compromised. | Phase 1 (judge selection) |
| P4 | **Cost rate table** for every model in the sweep, including the judge. | Phase 2 |
| P5 | **`zodiac_profile` routed through `AI_FEATURE_KEYS`.** It currently bypasses the AI router with a hardcoded `gpt-4o` and its own OpenAI client at [server/auth/service.ts:1085](server/auth/service.ts#L1085), so challenger outputs cannot be generated for it at all. | Phase 6 |
| P6 | **Synthetic personas, not real users.** Birth date + time + place is identifying. The 100 "users" should be engineered to cover the stratification space — which also gives better coverage than whatever real users happen to have. | Phase 0 |

---

## Phase 0 — Scaffold and materialization (no LLM)

**Build:** the `packages/core` ↔ `packages/adapters` split with the five port interfaces;
the four config schemas with validation; the CG adapter's `Datasource` (plus a fixture
adapter), `Renderer`s producing `RenderedContent`, and `Stratifier`; row materializer;
blinding (`modelRef` assignment + sealed map); `--estimate`.

**Why first:** two things are effectively unfixable later. Everything downstream consumes
`rows.jsonl`, so omitting `userId` — the cluster key — invalidates every statistic computed
afterwards. And the core/adapters boundary, once breached, is never restored: product-specific
branching accretes in the engine and the reuse goal is quietly lost.

**Gate:**
- `rows.jsonl` materializes for all 17 tracks from the fixture adapter, with correct row
  counts (27/user; 6 each for the two numerology tracks).
- **Boundary tests pass**: no `core/` file imports from `adapters/`; no domain vocabulary
  (`natal`, `transit`, `synastry`, `composite`, `tarot`, `numerology`, `zodiac`, `my_day`,
  `chart`, `birth`) appears anywhere in `core/` outside fixtures.
- `RenderedContent.fields` is addressable and `RenderedContent.sections` complete for every
  track — these two are the preconditions for evidence validation in Phase 1.
- The blinding test passes: no model string from `models.yaml` appears in `payloads.jsonl`.
- Renderers strip SVG blobs; `--estimate` prints a token projection per shard.
- `core` builds and its tests pass with **no adapter present** — proof it is standalone.

## Phase 1 — Vertical slice: `numerology`, one arm

**Build:** the universal kernel, universal metric block, and the `numerology` rubric pack;
per-track output-schema generation; the judge client (single provider, batch mode); the
post-parse validator **including the verbatim-quote substring check**.

**Track:** `numerology_brief` + `numerology_detailed` only. Chosen because the input is one
integer (grounding is unambiguous), the input space is finite at 142 cases, production already
enforces a strict schema, and judge calls are the cheapest in the suite (~$0.045).

**Gate:**
- A judged score exists for all 142 cases, one arm, end to end.
- **The full evidence contract is enforced**, verified against deliberately-corrupted judge
  response fixtures: a paraphrased `candidateQuote` is rejected; an unresolvable
  `inputRefs[].field` is rejected; a mismatched `inputRefs[].value` is flagged; a
  `section_missing` absence naming a section that *is* present is rejected; a score with all
  evidence arrays empty is rejected.
- Semantic absences (`input_fact_unaddressed`, `expected_element_absent`) are correctly
  labelled as flagged-not-verified rather than silently trusted.
- Abstentions appear where expected: `master_number_handling` abstains with
  `metric_not_applicable` on all non-master values, `year_anchoring` on all non-`personal_year`.
- Cache hits confirmed: `cacheReadInputTokens > 0` after the first calls of a shard.
- Manual read of 10 judged rows **via a draft of Report 5**: the scores and their evidence are
  defensible to a human. **If they are not, the rubric is wrong and no amount of downstream
  statistics will fix it.** Build the drill-down early for exactly this reason — it is the
  debugging tool for the rubric, not just a deliverable.

## Phase 2 — Statistics, cost, and pilot calibration

**Build:** the paired cluster bootstrap; CIs; paired deltas; Wilson intervals for proportions;
the composite; the cost module (per-reading, per-user, judge cost); Reports 1–5 skeletons; and
**Audits 1, 4, 5 and 6** — dataset, evidence, metrics, statistics. These four are computable
from a single-track sweep and each gates the phase.

**Run:** `numerology` across all arms — champion + challengers.

**Also run the pilot:** n≈30 users, measure the paired per-row SD per metric, and back-compute
the required n per track. This replaces the assumed SD in
[02-statistical-design §8](02-statistical-design.md#8-power-and-calibrating-n) with a measured one.

**Gate:**
- Bootstrap validated against a **synthetic dataset with a known injected effect**: it must
  recover the effect and its interval must cover the true value at the nominal rate. Do not
  skip this — a bootstrap with a subtle resampling bug produces plausible, wrong intervals
  and nothing downstream will reveal it.
- Cluster resampling verified: a user drawn twice contributes all their rows twice.
- Zero-failure gate reports a **Wilson upper bound**, not `[0, 0]`.
- Per-user cost reconciles against the sum of its rows.
- Required-n computed per track from measured SD.
- **Audit 5 register reconciliation passes**: computed totals match the stated 31 keys /
  9 gate keys / 37 assignments / 11 gate assignments.
- **Audit 4** reports a ≥99% verbatim-quote pass rate and a resolved-`inputRefs[].field` rate, with the
  exact/semantic absence split broken out.
- Threshold-sensitivity table renders for the numerology tracks.

## Phase 3 — Judge calibration

**The phase that decides whether any of this is trustworthy.** Build and run all four
reliability instruments on the completed numerology sweep.

1. **Self-agreement** — re-judge 10%, same judge and config. Target ≥90% within ±1.
2. **Cross-judge agreement** — different-vendor secondary on the same 10%. Target ≥70% within ±1.
3. **Reference-contamination check** — the same rows with `includeSilverReference` true and
   false. Determines whether the universal metrics need a separate reference-free pass, which
   is the largest single judge-cost decision in the project
   ([03-cost-analysis §4](03-cost-analysis.md#4-the-judges-own-cost)).
4. **Silver as a blind arm** — is the human-reviewed reference actually better than an
   unreviewed frontier arm, and does the judge show a suspiciously uniform preference for it?

**Build:** the human audit slice sampler and the review-import path, **Audits 2, 3 and 8**
(prompt, judge, gates), and Reports 6 and 7 — the reliability appendix and the sign-off sheet.
Sample for review: all `substantive_disagreement` rows, all cross-judge gate disagreements, all
30 master-number numerology cases, a sample of semantic absences for Audit 4, plus a random
remainder.

This phase also runs the **first end-to-end human review** using the Part B sequence in
[04](04-reporting-and-human-review.md#what-the-reviewer-is-asked-to-do), on the numerology
tracks only. The point is to exercise the review process while it is cheap to change.

**Gate:**
- Agreement thresholds met. **Where a metric fails, the fix is the rubric wording, not the
  threshold** — re-run Phase 3 after each rubric revision.
- The judge noise band is quantified per metric, so §6's "indistinguishable" branch is operable.
- The contamination verdict is recorded and the scoring topology fixed accordingly.
- Human reviewers agree with the judge on the audit slice at a rate that is written down. If
  humans and the judge disagree materially, **stop and fix the rubric before Phase 4.**
- **Audit 8 planted-defect tests pass for the 4 gates reachable on numerology** (the two
  supplements plus `input_grounding` and `structural_completeness`); the remaining gates are
  labelled UNTESTED until their tracks land.
- A reviewer completes the full Part B sequence and signs Report 7 for both numerology tracks —
  proving the human loop works before it is applied to 17 tracks.

## Phase 4 — `tarot` and `my_day`

Next-cheapest, and both add new machinery worth exercising while calls are still cheap.

- `tarot` — the input is already a pure object in production (`TarotReadingData`, no DB id);
  exercises a **hard gate with an exact answer** (`card_fidelity`: orientation and position
  come from the input) and the `"General guidance"` conditional in `question_responsiveness`.
- `my_day` — production already has a full Zod contract; exercises the largest field count
  (~100), two hard gates, and `activity_validity`'s structural checks.

**Gate:** both tracks reporting; `card_fidelity` demonstrably catches a planted orientation
inversion; `activity_validity` catches a planted 5-activity output and a domain/type mismatch.
Planted-defect tests are how you know a gate works — a gate that has never fired is untested.

## Phase 5 — The four chart tracks

`natal_*`, `transit_*`, `synastry_*`, `composite_*`, `number_compatibility_*`.

Last because they are the most expensive to judge (~$0.14/call, ~45k input tokens) and the
least structurally constrained — **`natal` and `tarot` have no output validation at all in
production**, so `structural_completeness` will do real work here and its rubric wording needs
the calibration from Phase 3 behind it.

**Gate:** all ten tracks reporting; `aspect_coverage` and `house_domain_accuracy` produce
discriminating scores rather than clustering at 4; `score_narrative_coherence` catches a
planted score/prose mismatch on synastry.

## Phase 6 — `static_scores` and `zodiac_profile`

- `static_scores` — `injected_value_fidelity` is an **exact** comparison against the ten
  pre-computed values. Test it with a planted altered value.
- `zodiac_profile` — blocked on **P5** (router bypass). `famous_people_plausibility` is the
  suite's designed hallucination trap; verify that the judge abstains rather than guessing
  when it does not know a person's birthday.

**Gate:** all 17 tracks reporting; both exact-fact gates catch planted defects.

## Phase 7 — Full sweep and decision

Run all 17 tracks × all arms. Produce the full report bundle — all seven reports and all eight
component audits ([04](04-reporting-and-human-review.md)) — then hand it to a human reviewer
and record the decisions.

Audit 7 (cost) gets its first **billing reconciliation** here: computed judge cost against the
provider's actual invoice for the run. Until that reconciles, every cost figure is a model of
cost rather than a measurement, and the report must say so.

**Gate:**
- Every track has a recommendation **or** an explicit `NO RECOMMENDATION` with a reason.
- Every headline number carries a CI.
- Multiplicity correction applied to the primary deltas and reported raw and adjusted.
- Human audit slice reviewed and its agreement rate stated in the report.
- **Sanity floor:** the sweep includes a deliberately weak arm — a small model, or a
  deliberately degraded prompt. **If the judge does not rank it last on every track, the judge
  is not working and the results are void.** Cheap, and the single most informative test in
  the plan.
- **All eight component audits pass or are explicitly accepted with a recorded note.**
- **All 12 hard gates have fired at least once on real data or in a planted-defect test**; any
  gate still UNTESTED is named in Report 1's blocking issues.
- Every gate firing has been human-reviewed (Audit 8).
- Report 7 signed per track: `accept` / `override` / `defer`, with a reason on every override.
  **The engine's recommendation is not the decision** — the decision is what is in
  `decisions.json`.

## Phase 8 — Hardening

Resumability under real failure; per-provider rate-limit backoff; shard parallelism; report
polish; a scheduled re-run path for the annual `personal_year` regeneration (12 of the 142
numerology cases change every year).

---

## Risks

| Risk | Mitigation |
|---|---|
| **Judge shares a family with the champion or silver generator** — bias lands on the incumbent | P3; cross-judge agreement as standing detector; silver-as-blind-arm as the probe |
| **Rubric anchors ambiguous** — low agreement, unusable scores | Phase 3 gates on agreement *before* the expensive tracks; fix wording, never the threshold |
| **Judge noise exceeds model differences** — no ranking is possible | measured in Phase 3; §6 Step 5 makes "indistinguishable" a legitimate reported outcome rather than a failure to report |
| **Silver is not actually better than an unreviewed arm** — the review stage adds nothing | detected by silver-as-blind-arm in Phase 3; if confirmed, reconsider the reference design before Phase 5 |
| **Bootstrap implemented subtly wrong** — plausible, wrong intervals | Phase 2 gate: recover a known injected effect on synthetic data |
| **Judge cost overruns on the chart tracks** | `--estimate` mandatory; contamination verdict determines whether the reference-free pass halves input on those tracks |
| **Renderer regression inflates tokens** (e.g. SVG blobs return) | token projection in `--estimate` is checked per run; a jump fails the shard |
| **Prompt drift mid-programme** — scores silently pooled across rubric versions | prompt hashes in `manifest.json`; `report` hard-fails on mixed hashes |
| **Silver/challenger tables diverge from the datasource contract** | fixture adapter first; reconcile at P1 before Phase 1 |
| **Core/adapters boundary erodes** — engine becomes CG-only, reuse goal lost | two boundary tests in CI from Phase 0; `core` must build and test with no adapter present |
| **A metric does not discriminate**, contributing noise to the composite | Audit 5 flags >80% single-value distributions and >0.9 inter-metric correlation |
| **A gate never fires and is mistaken for a passed check** | Audit 8 labels it UNTESTED and surfaces it in Report 1's blocking issues; planted defects for all 12 |
| **Evidence cost creep** — richer evidence raises judge output ~75% | `maxQuotesPerMetric` / `maxInputRefsPerMetric` are config; `--estimate` prices the change before a sweep |
