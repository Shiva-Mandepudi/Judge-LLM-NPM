# Judge Service Rebuild Plan — Toward `docs/LLM PLAN`

**Status:** Phases 0–6 implementation complete; live judge execution and human sign-off remain fail-closed pending approved run inputs.
**Last reviewed:** 2026-09-09.
**Source of truth for design:** [`docs/LLM PLAN/`](./LLM%20PLAN/). This document does not
restate rubric text, schemas, or statistical formulas that already exist there — it maps that
plan onto **this repo's actual current state** and turns it into an ordered, checkable build
sequence. When this document and `docs/LLM PLAN/` conflict, `docs/LLM PLAN/` wins; fix this
document, not the other way around.

The plan is the implementation checklist; runtime changes are recorded in §8.

---

## 0. Non-negotiable rules for this rebuild

These apply to every phase below without exception. A PR that violates one of these is wrong
regardless of what else it gets right.

1. **No fallbacks.** No "if the new path fails, fall back to the old pairwise judge / old
   rubric / old schema" branches, anywhere, ever — not in code, not as a feature flag, not as a
   migration safety net. If the new evidence-gated pipeline isn't ready for a track, that track
   is simply **not evaluated yet** (`NO RECOMMENDATION`), not silently served by legacy scoring.
2. **No legacy code reused as a fallback or a shortcut that reintroduces the old model.** The
   current pairwise A/B win/tie/loss judge (`judge-prompts.ts`, `shared/rubric.ts`,
   `blind-ab-service.ts`'s 2-arm design, `decision-service.ts`'s pass/hold/rollback rule,
   `deterministic-checks.ts`) is the **old architecture** and is being replaced, not extended.
   It is isolated and removed from the active runtime as the new path is cut over — see §6 for
   the deletion line. Reusing its *infrastructure* (Postgres, Cloud Tasks, batch/idempotency
   plumbing, HMAC auth to CosmicGuidance) is fine; reusing its *evaluation logic* is not.
3. **The prompt files under `docs/LLM PLAN/01-judge-prompt/` are given, not drafted.** The
   kernel text, the output contract, and every rubric pack are copied byte-for-byte into the
   runtime prompt location. No paraphrasing, no "improving," no filling in a `{{placeholder}}`
   with anything other than what the renderer rules specify. If a rubric pack looks wrong,
   that's a conversation to have before Phase 1, not a silent edit during implementation.
4. **Every threshold is config, not a judgment call baked into code.** `qualityMarginDelta`,
   `maxFailureRateUpperBound`, composite weights, sample sizes — all in YAML, all overridable
   without a code change, per [00-architecture](./LLM%20PLAN/03-build-plan/00-architecture-and-parametrization.md).
5. **A phase's exit gate is binary.** "Mostly working" does not advance a phase. The gates in
   §5 below are copied from [01-build-phases.md](./LLM%20PLAN/03-build-plan/01-build-phases.md)
   and are not negotiable mid-phase — if a gate turns out to be wrong, that's a plan change,
   discussed and made explicitly, not quietly skipped.
6. **The engine never decides; it recommends.** No code path auto-ships a model. The output of
   a full sweep is a report and a `decisions.json` waiting for a human to fill in — see
   [04-reporting-and-human-review.md](./LLM%20PLAN/03-build-plan/04-reporting-and-human-review.md).
7. **The judge-service database stays fully separate from CosmicGuidance's production
   database — no exceptions, and this does not change in the rebuild.** All new tables in §4
   (`eval_rows`, `eval_silver_outputs`, `eval_model_map`, `eval_judgements_v2`,
   `eval_run_manifests`, any persona/actor table) live in the judge-service's own Postgres
   instance (`JUDGE_DATABASE_URL`), exactly like every existing `eval_*` table does today.
   CosmicGuidance's database is read-only from this service's perspective, reached only
   through the existing HMAC-authenticated internal generation/calculation interface — **never
   a direct DB connection, and never a shared schema.** The reason this separation exists is
   deliberate and unchanged by the rebuild: challenger-model outputs, silver references, and
   judge scores are evaluation artifacts generated *outside* normal product traffic, and mixing
   them into CG's production tables would risk that content leaking into what real users are
   served, or corrupting CG's own operational data. "One repo" (§3.1) is a code-organization
   decision only and has no bearing on this — it does not mean one database, and nothing in
   this plan should be read as consolidating the two databases.
8. **A failed or incomplete new path fails closed.** Missing silver, missing candidate output,
   an unsupported track, an invalid judge response, or an unresolved prerequisite produces a
   recorded `NO RECOMMENDATION`/blocked status. It never selects a legacy path, invents a row,
   substitutes a model, or silently drops the case.
9. **Retries are transport retries only.** A bounded retry of the same provider request is
   allowed for configured transient `429`/`5xx` failures. A retry may not change provider,
   model, prompt, schema, scoring logic, or execution path; it is not a fallback.
10. **Agent cleanup is part of done.** After a change, remove temporary, duplicate, dead,
    or agent-only files created while implementing or verifying it. Test fixtures and run
    artifacts may remain only when they are named, referenced, and covered by the plan;
    convenience scaffolding must not become repository surface area.

---

## 1. Current-state inventory (read before writing any code)

### 1.1 What this repo already has that the plan needs — reuse these

| Asset | Where | Reuse as |
|---|---|---|
| **100 synthetic actors and compatibility coverage** | `../AB Dataset.xlsx` plus the imported judge DB corpus (`cb-actor-001`…`cb-actor-100`) | This is the `users: 100` cluster frame. The live judge DB verification covers all 100 actors for compatibility tracks; do not build a second persona generator. |
| **Champion model observation** | `my stuff.md`, `scripts/prepare-cg-batch-corpus.ts:10`, and existing artifacts | `gpt-5.6-sol` is the model identifier used by the current corpus and is labelled OpenAI in the existing artifacts. Treat this as a provisional observed value, not a completed model approval; P2/P3 still require an explicit run-manifest confirmation before any paid run. |
| **Numerology silver pipeline** | `docs/numerology-gold-dataset.md` only | The document references `server/services/numerology-generation-request-builder.ts`, `server/services/numerology-gold-dataset.ts`, and `scripts/numerology-gold-pipeline.ts`, but those files do not exist in this checkout. This is a missing prerequisite, not reusable implementation. Build/import the silver workflow explicitly; do not claim that the 142 cases are already reviewed. |
| **Production-realistic batch corpus** | `artifacts/batches/cg-production-batch-only-20260828/` plus `artifacts/cb-actor-001-standard-report.md` | The imported judge DB currently covers 100 actors for 15 target tracks; `my_day` and `static_scores` have no source rows and remain `NO RECOMMENDATION`. Formal external corpus reconciliation is still required before paid evaluation. |
| **Batch/idempotency/generation-record infrastructure** | `shared/schema.ts`: `evalGenerationRuns`, `evalPreparedRequests`, `evalReferenceGenerations`, `evalIdempotencyKeys`; `server/workers/cloud-tasks-client.ts` | Reuse only the provider-neutral lifecycle, idempotency, cost-record, and task-delivery mechanics after contract tests. The existing OpenAI-specific batch scripts are not the new judge execution path and must not be treated as provider-agnostic. |
| **Cloud Run + HMAC boundary to CosmicGuidance + own Postgres** | `README.md` architecture section, `server/auth/service-auth.ts`, `server/services/generation-client.ts` | The separation and HMAC boundary exist. The current live adapter is limited, so the 17-track target still needs explicit CG endpoint/fixture coverage. Keep one repo (this one) rather than creating a second physical repo. |
| **SVG sanitization requirement** | Renderer rule in the LLM plan; `removeSvgContent` lives in the separate CosmicGuidance repo | Do not import code across the two repos or connect to CG's database. Define an adapter-owned sanitizer with fixture tests against the same contract. Its behavior must be hash/audit-visible; it is not a legacy fallback. |

### 1.2 Current operational baseline — do not confuse it with target coverage

The target plan and the current service describe different systems. These facts are the
starting line for the rebuild:

| Area | Current checkout | Rebuild implication |
|---|---|---|
| Track registry | `shared/schema.ts` currently registers 6 tracks: `my_day_model_comparison`, `my_day_batch_vs_live`, `numerology`, `brief_readings`, `ai_chat`, `safety_injection` | The LLM plan's 17 track keys are a new target contract. Add them through an explicit versioned track registry; do not reinterpret the six existing tracks as the 17. |
| Seed datasets | 6 dataset directories, 18 JSONL cases total | These are fixtures/legacy benchmark inputs, not the 100-user production-shaped sweep. Every target track needs a declared fixture and a provenance-backed production adapter before it can be evaluated. |
| Synthetic actors | `AB Dataset.xlsx` is validated by `prepare-cg-batch-corpus.ts` as `cb-actor-001` through `cb-actor-100` | The 100 records are usable as the cluster frame. The judge DB verification confirms 100/100 compatibility coverage in the imported corpus. |
| Current corpus shape | Actors 001–005 receive 14 generated AI cases; actors 006–100 receive 26. `my_day` and `static_scores` are not created by the corpus builder; `universal_insights` is created but is not one of the 17 target tracks. | Do not assert 27 rows/user or manufacture missing rows. Materialization must report exact per-track/user coverage and withhold unsupported tracks. |
| Current CG boundary | `README.md` states the live internal adapter is limited to numerology; generation/calculation requests use HMAC endpoints | The new datasource may consume only versioned HMAC responses or imported immutable artifacts. It must not read CosmicGuidance tables directly. |
| Current judge path | `server/workers/job-runner.ts` calls deterministic checks, 2-arm A/B blinding, the legacy judge, and legacy aggregation | This is inventory only. The rebuilt pipeline must not call `runJob`, `judge-prompts.ts`, `deterministic-checks.ts`, `blind-ab-service.ts`, `decision-service.ts`, or their scoring path. |
| Verification baseline | `npm run check` and `npm run datasets:validate` pass. Test scripts currently fail before test discovery because the installed `tsx` resolves the Windows path/glob literally in this Linux/WSL checkout. | Fix the test command/tooling as a Phase 0 prerequisite and record a real baseline. The README claim that all 25 tests pass is not verified by the current checkout. |

### 1.3 What exists but is the old architecture — replace, do not extend

| Component | File | Disposition |
|---|---|---|
| Pairwise A/B judge prompt (winner + hard-gate pass/fail, no 1–5 scale, no evidence) | `server/services/judge-prompts.ts` | Delete once the kernel+rubric-pack composer (Phase 1) covers its trigger tracks. |
| 8 "core dimensions" + per-track supplements | `shared/rubric.ts` | Delete. Replaced by `config/metrics.yaml` generated from the plan's 8 universal + 31 reading-specific + 4 comparative metrics. |
| Deterministic pre-judge checks | `server/services/deterministic-checks.ts` | Delete per the plan's explicit "no pre-judge checks — LLM checks only" decision (`structural_completeness`/`safety_compliance` become judged metrics). The one mechanical exception (unparseable output) is kept as a `loadStatus` check, not a scoring check. |
| 2-arm-only blinding | `server/services/blind-ab-service.ts` | Replace with N-arm `modelRef` assignment + sealed map (§4). |
| `pass \| hold \| rollback` decision rule | `server/services/decision-service.ts` | Replace with the 4-step gate→degeneracy→quality→cost lexicographic rule (§4, from `02-statistical-design.md §6`). |
| Legacy `dimensionScores` / `pairwiseWinner` storage | `shared/schema.ts: evalJudgeScores` | Superseded by the new evidence-gated `metrics` JSON shape (§4). Table is not reused for new rows; either migrated or left as historical/read-only. |
| Simple mean + win/tie/loss stats | `server/services/stats-service.ts` | Replace with cluster bootstrap (§4). |
| Ad hoc per-experiment JSON report | `server/services/report-service.ts` | Replace with the 7-report + 8-audit bundle (§4, Phase 2 onward). |

**Cut line:** freeze the old pipeline for inventory and historical reads only. The new pipeline
must not import or call its evaluation logic, and there is no dual-write, compatibility mode,
feature flag, or track-by-track fallback. Once the new run reaches its gate, remove the old
runtime path and retain only immutable historical artifacts needed for audit. A track that is
not ready is withheld with `NO RECOMMENDATION`; it is not sent through the old pipeline.

### 1.4 CosmicGuidance production tables — verified against the live repo, not the plan's citations

The plan doc's file:line citations for CosmicGuidance predate some renames/moves. The following
names were observed in the adjacent repo and are useful for an endpoint/export contract. They
are **not permission for a direct database connection**: the judge-service may access CG only
through the authenticated internal API or a versioned immutable export.

| Reading type | Actual table | Notes |
|---|---|---|
| `natal_*` | `natalCharts` | **not** `natal_readings`; `userId` + `personId` + `chartData`/`chartDetails`/`briefInsight`/`detailedInsight` (jsonb) |
| `transit_*` | `transitReadings` | `userId` + `personId` + `transitDate`/`transitTime` + brief/detailed insight jsonb |
| `synastry_*`, `composite_*` | `compatibilityReadings` | **one table for both** — disambiguated by a `readingType` column; `userId` + `person1Id` + `person2Id` |
| `number_compatibility_*` | `numerologyCompatibility` | `userId` + `compatibilityScores`/`interpretation` jsonb |
| `numerology_*` | `numerologyReadings` → `numerologyProfiles.userId` | table names observed in CG; the referenced gold/silver pipeline is absent from this checkout and must not be assumed |
| `tarot_*` | `tarotReadings` | exists as expected |
| `my_day` | `myDayBatchJobs` / `myDayBatchJobItems` | no separate "readings" table — the batch job item is the row |
| `zodiac_profile` | `userZodiacProfiles` | `userId` + `zodiacInsights` jsonb |
| `static_scores` | `userScores` | `userId` + `scoreType` + `scoreInsights` jsonb |
| (unrelated but referenced) | `userStaticProfiles` | 40+ field static profile + `chatgptResponse` — **not** the same thing as `zodiac_profile`; do not conflate |

Also verified:
- **`removeSvgContent`** exists as cited, in `chart-details-processor.ts:67`, but it lives in
  the separate CG repo. Match its sanitization behavior with an adapter-owned implementation and
  fixtures; do not import code across repos or depend on a CG database connection.
- **Gemini call** at `unified-ai-service.ts:418` does pass only `responseMimeType` without
  `responseSchema` (OpenAI's call at :314-320 gets the schema) — the plan's warning to not
  repeat this mistake in the new judge client is confirmed still live and correct.
- **`ai_usage_metrics` does not exist** in CosmicGuidance. The plan's cost-analysis doc names
  it as one possible volume source for the consolidated monthly cost projection
  (§3-cost-analysis). Do not add a fallback volume source: until an authoritative usage source
  is confirmed or built, report consolidated volume and cost as `unknown/partial` and block any
  cost-based recommendation that depends on it.
- **No per-reading "challenger model" column anywhere.** A/B assignment in CosmicGuidance
  lives on `aiPromptTemplates.abTestGroup`, not on any reading row. This doesn't block
  anything — the judge-service's own `modelRef` is the source of truth for which arm is which
  — but it means the `Datasource` adapter cannot infer "which model generated this" from
  CosmicGuidance data; the challenger arm's output must come from a **judge-service-initiated
  generation** against CG's generation interface or an explicitly imported immutable artifact,
  not from scanning an existing CG table for a challenger row.

### 1.5 Remaining external prerequisites

- Confirm with the CosmicGuidance repo owner whether `artifacts/batches/cg-production-batch-only-20260828/` has been reconciled/imported yet, and which target tracks/depths it actually covers. Do not assume from the generator script alone; the manifest proves 2,526 requests for actors 002–100, not a complete 17-track sweep.
- The no-silver policy is closed for this rebuild; a separate silver workflow is not part of the Phase 0 scaffold.
- Compatibility coverage is closed for the currently imported judge DB corpus at 100/100 actors; never duplicate or invent outputs if a future import differs.
- The 17-track registry is reconciled in `config/tracks/*.yaml`; the legacy six-track enum remains historical and is not reused by the new pipeline.
- **P5 (`zodiac_profile` router bypass) could not be confirmed at the cited line** (`server/auth/service.ts:1085`) — a targeted re-check found zodiac_profile using standard `AI_FEATURE_KEYS` routing there, not a hardcoded `gpt-4o` client. Either it was already fixed, or it lives somewhere else in the codebase. **Re-verify specifically before Phase 6**, don't carry the plan's citation forward as fact — but also don't assume it's fixed; grep CosmicGuidance for a raw `new OpenAI(` or hardcoded `"gpt-4o"` near the zodiac profile generation path before that phase starts.
- Confirm the champion's exact provider model ID/family and decide `challengers` for `config/models.yaml`. The current `gpt-5.6-sol` string is observed in artifacts, but a paid sweep is blocked until it is confirmed.

---

## 2. Scope: the 17 tracks (unchanged from the plan)

Copied for reference only — see [README.md#scope-the-17-tracks](./LLM%20PLAN/README.md#scope-the-17-tracks)
for the authoritative table, exclusions, and reasoning. The target arithmetic is 27 rows/user ×
100 users × (1 champion + k challengers), but the current corpus does not satisfy it. Do not add
or remove tracks without updating that file first, and do not claim target coverage until the
dataset audit proves it.

The 17 tracks are a target contract, not current runtime coverage. Unsupported or incomplete
tracks are reported as `NO RECOMMENDATION`; they are never routed to the six-track legacy
pipeline.

---

## 3. Target architecture (summary — full detail in `03-build-plan/00`)

- **One repo (this one), two internal boundaries**, not two physical repos:
  - `server/core/` — product-agnostic: judging, evidence validation, scoring, statistics, cost,
    audit, report. Contains zero astrology vocabulary (enforced by the two boundary tests from
    [00-architecture](./LLM%20PLAN/03-build-plan/00-architecture-and-parametrization.md#the-core--adapters-split)).
  - `server/adapters/cosmic-guidance/` — datasource, renderers, strata, the 17 `TrackSpec`
    configs, and a **pointer** to the rubric packs, sourced byte-for-byte from
    `docs/LLM PLAN/01-judge-prompt/` per rule #3 in §0.
  - `server/providers/` already exists and is close to the `JudgeProvider` port shape — extend,
    don't replace.
- **Row shape**, **blinding**, **run artifacts**, **config files** (`models.yaml`,
  `tracks/<track>.yaml`, `thresholds.yaml`, `run.yaml`) — exactly as specified in
  [00-architecture-and-parametrization.md](./LLM%20PLAN/03-build-plan/00-architecture-and-parametrization.md).
  Do not redesign these; implement them as written.
- **Judge output contract** — exactly the schema in
  [01-output-contract.md](./LLM%20PLAN/01-judge-prompt/01-output-contract.md), generated per
  track from the composed rubric, never hand-maintained.
- **Statistics, cost, reporting** — exactly as specified in `02-statistical-design.md`,
  `03-cost-analysis.md`, `04-reporting-and-human-review.md`.

### 3.1 Why one repo, not two

The plan's `README.md` calls for "a separate repo" for portability. This repo **already is**
separate from CosmicGuidance (own DB, own deploy, no code import). Splitting `judge-service`
itself into a second `shunyaverse-eval` repo buys nothing right now and costs a second CI
pipeline, a second deploy target, and a versioning problem between the two — pure overhead
for a team of the current size. The two-directory boundary (`server/core/` vs
`server/adapters/`) plus the two automated boundary tests deliver the same reuse guarantee
without the repo split. Revisit only when a second ShunyaVerse product actually needs the
engine.

**This is a repo decision only — the two databases stay separate regardless**, per rule #7 in
§0. "One repo" describes where the *code* lives; it says nothing about where *data* lives, and
the judge-service's Postgres instance and CosmicGuidance's production Postgres instance remain
two physically separate databases with no shared schema and no direct cross-connection, exactly
as they are today.

---

## 4. Data model changes required (new versioned artifacts; legacy records remain read-only)

**All tables below live in the judge-service's own database (`JUDGE_DATABASE_URL`), never in
CosmicGuidance's production database — see rule #7 in §0.** Silver and candidate outputs enter
through a versioned import or the authenticated generation interface, are copied into these
judge-owned artifacts, and are evaluated entirely on this side of the boundary. Nothing is
written back to CosmicGuidance and no CG table is queried directly.

New tables needed in `shared/schema.ts` (naming indicative, finalize during Phase 0):

| Table | Purpose | Key columns |
|---|---|---|
| `eval_silver_outputs` | one row per (track, stratum key) silver/reference content, human-reviewed | `track`, `stratumKey`, `output` (jsonb), `reviewStatus`, `promptVersion`, `contentHash` |
| `eval_rows` | the materialized row atom | `rowId` (PK, hash), `runId`, `userId`, `track`, `stratum` (jsonb), `modelRef`, `loadStatus` |
| `eval_model_map` | sealed `modelRef → model` mapping, one per run | `runId`, `modelRef`, `model` — written once, access-restricted, and unavailable to materialization/judge/evidence code until aggregation stage 5 |
| `eval_judgements_v2` | raw + validated per-row judge output, evidence-gated shape | see [01-output-contract.md#judge-call-record](./LLM%20PLAN/01-judge-prompt/01-output-contract.md#judge-call-record) verbatim |
| `eval_run_manifests` | one per run: config snapshot, prompt hashes, git SHA, bootstrap seed | per `00-architecture#run-artifacts` |

`userId` is mandatory and non-nullable on `eval_rows` — this is the cluster key the entire
statistical design depends on; getting this wrong is explicitly called out in the plan as
"unfixable later" (Phase 0 gate).

Existing tables are not silently repurposed. Their current rows remain historical/read-only.
Only provider-neutral mechanics may be reused after contract tests pass:
`evalGenerationRuns`, `evalPreparedRequests`, `evalReferenceGenerations`, and
`evalIdempotencyKeys`. Use a dedicated synthetic-persona registry (or a clearly versioned
`eval_personas` table) sourced from `AB Dataset.xlsx`; do not overload `evalDatasets` with
persona identity.

---

## 5. Phase-by-phase plan

Each phase below = the plan's phase (`01-build-phases.md`) + this repo's concrete starting
point + what specifically must be built. **A phase does not start until the previous phase's
exit gate has passed and been recorded** (a short note in this file's changelog, §8, is enough).

### Phase 0 — Scaffold and materialization (no LLM calls, no cost)

**Build**
- `server/core/` and `server/adapters/cosmic-guidance/` directory split + the two boundary
  tests (import-direction static check; domain-vocabulary grep) wired into CI.
- The five ports (`Datasource`, `Renderer`, `Stratifier`, `TrackSpec`, `JudgeProvider`) as
  TypeScript interfaces in `server/core/contracts/`.
- CG `Datasource` adapter reading from the dedicated synthetic-persona registry and
  versioned HMAC responses or immutable imported artifacts. It must not read CosmicGuidance
  tables directly.
- `RenderedContent`-producing `Renderer` per reading shape. Fixture renderers are test-only
  inputs for the Phase 0 contract gate; an unsupported production track fails closed and is not
  routed to a fixture.
- Row materializer producing `rows.jsonl`; `modelRef` assignment + `eval_model_map` sealing.
- `--estimate` command (stages 1–2 only, prints token/cost projection).
- New `eval_rows`, `eval_model_map`, `eval_run_manifests` tables (migration).

**Prerequisites to close first:** the silver-source/import contract, the versioned HMAC/export
contract for each target track, the 100-user/partner coverage decision, and the test-command
baseline. P6 is only partially satisfied: the 100 actor records exist, but partner coverage is
not complete.

**Exit gate** (from the plan, verbatim conditions):
- `rows.jsonl` materializes for all 17 target tracks via the fixture adapter with the declared
  target counts (27/user; 6 each for each numerology depth), while a separate dataset audit
  records that the current real corpus does not yet meet those counts.
- Both boundary tests pass in CI.
- `RenderedContent.fields`/`sections` addressable and complete for every track.
- Blinding test passes: no string from `models.yaml` appears in `payloads.jsonl`.
- Adapter-owned renderers strip SVG blobs with fixture parity to the CG sanitizer; `--estimate` prints a token
  projection per shard.
- `server/core` builds and its tests pass with **no adapter present**.

### Phase 1 — Vertical slice: numerology, one arm

**Build**
- Load the kernel (`00-universal-kernel.md`), universal metric block
  (`00-universal-metrics.md`), and `numerology.md` rubric pack byte-for-byte from
  `docs/LLM PLAN/`, or copy them only through a checked hash-preserving build step. Never
  hand-edit a runtime copy and never alter the given prompt text.
- Per-track JSON-schema generator (from composed rubric → provider structured-output schema).
- Judge client against the Anthropic provider (already exists — extend to the new payload/
  schema shape; this satisfies judge-independence since champion is OpenAI, per §1.1).
- Post-parse validator with every rule in
  [01-output-contract.md#post-parse-validation](./LLM%20PLAN/01-judge-prompt/01-output-contract.md#post-parse-validation--reject-never-repair),
  including the verbatim-quote substring check.
- Build the missing silver-source workflow and import its 142 canonical cases into
  `eval_silver_outputs` only after provenance, human-review status, content hashes, and
  prompt/version hashes pass validation. The absent files named by `docs/numerology-gold-dataset.md`
  cannot be treated as an existing pipeline.

**Exit gate:** all of `01-build-phases.md`'s Phase 1 gate — judged score for all 142 cases,
one arm; full evidence contract enforced against corrupted-response fixtures; abstentions
appear where expected (`master_number_handling`, `year_anchoring`); cache hits confirmed;
manual read of 10 judged rows via a draft Report 5 is defensible.

### Phase 2 — Statistics, cost, pilot calibration

**Build:** paired cluster bootstrap, Wilson intervals, composite quality computation, cost
module (per-reading/per-user/judge), Reports 1–5 skeletons, Audits 1/4/5/6.
**Run:** numerology across champion + challengers. If a pilot is used to calibrate variance, it
is a separate calibration artifact (n≈30 users) and never replaces the exhaustive 142-case
numerology input universe or becomes a fallback result.
**Exit gate:** bootstrap recovers a known injected effect on synthetic data; cluster resampling
verified; zero-failure gate reports a Wilson upper bound; Audit 5 register reconciliation
passes (31/9/37/11); Audit 4 ≥99% verbatim-quote pass rate.

### Phase 3 — Judge calibration

**Build:** self-agreement + cross-judge agreement (the current repo has Anthropic, OpenAI, and
mock providers but no Gemini provider; implement and validate an approved independent provider
before configuring one), reference-contamination check, silver-as-blind-arm, human audit slice sampler +
review-import, Audits 2/3/8, Reports 6–7.
**Exit gate:** agreement thresholds met (≥90% self, ≥70% cross, within ±1); contamination
verdict recorded; a human reviewer completes the full Part B sequence and signs Report 7 for
both numerology tracks.

### Phase 4 — `tarot` and `my_day`

New rubric packs (loaded byte-for-byte), new renderers, new track configs. `my_day` needs an
explicit generation/import pass; the existing production batch corpus does not establish its
coverage.
**Exit gate:** both tracks reporting; `card_fidelity` and `activity_validity` demonstrably
catch planted defects.

### Phase 5 — The five chart/compatibility track families

`natal_*`, `transit_*`, `synastry_*`, `composite_*`, `number_compatibility_*`. Most expensive,
least structurally constrained — run last per the plan's own reasoning.
**Exit gate:** all ten tracks reporting; supplement metrics discriminate (not clustering at 4);
`score_narrative_coherence` catches a planted score/prose mismatch.

### Phase 6 — `static_scores` and `zodiac_profile`

**P5 status is unresolved, not confirmed-fixed** (§1.5) — re-verify whether `zodiac_profile`
still bypasses `AI_FEATURE_KEYS` before this phase starts. If it still bypasses routing, it's a
CosmicGuidance-side fix (outside this repo) that blocks challenger-arm generation for this
track specifically. That track remains blocked/NO RECOMMENDATION; it is never sent through a
legacy or fixture fallback. Other Phase 6 preparation may proceed independently.
**Exit gate:** all 17 tracks reporting; both exact-fact gates (`injected_value_fidelity`,
`famous_people_plausibility`) catch planted defects.

### Phase 7 — Full sweep and decision

Run all 17 tracks × all arms (champion + challengers + silver-as-blind-arm). Full 7-report +
8-audit bundle. Include a deliberately weak sanity-floor arm.
**Exit gate:** every track has a recommendation or an explicit `NO RECOMMENDATION`; every
number carries a CI; sanity-floor arm ranks last everywhere or the run is void; all 12 gates
fired at least once (real or planted); `decisions.json` signed per track.

### Phase 8 — Hardening

Resumability under real failure, per-provider rate-limit backoff, shard parallelism, the
annual `personal_year` regeneration cron (12 of the 142 numerology cases change every year).
The schedule is blocked until the new silver producer exists; do not refer to the absent legacy
pipeline or its unimplemented `--year` flag.

---

## 6. Cutover and legacy deletion

This is a rebuild, not a compatibility migration. The sequence is:

1. Freeze changes to the legacy evaluator. Keep its database rows only as historical artifacts;
   do not add new tracks, new scoring, or dual-write behavior.
2. Build and validate the new pipeline behind the core/adapters boundary. New code may reuse
   transport/database mechanics only after contract tests prove that no legacy evaluation logic
   is called.
3. Run the new pipeline's phase gates. A track that fails a gate is blocked with
   `NO RECOMMENDATION`; it is not evaluated by the old path.
4. After the first accepted new full sweep, remove the active imports/routes/jobs for
   `judge-prompts.ts`, `shared/rubric.ts`, `deterministic-checks.ts`,
   `blind-ab-service.ts`, `decision-service.ts`, and legacy aggregation. Retain old database
   rows and export manifests as read-only audit history, with no new writes.
5. CI must fail if the new pipeline imports any legacy evaluation module or if a fallback branch
   is introduced.

No production/user traffic is involved in this service. Therefore preserving the old evaluator
as a live safety net is not a requirement and would violate the no-fallback rule.

---

## 7. Config artifacts to create (Phase 0 deliverables)

`config/models.yaml`, `config/tracks/<track>.yaml` × 17, `config/thresholds.yaml`,
`config/run.yaml` — schemas exactly as given in
[00-architecture-and-parametrization.md](./LLM%20PLAN/03-build-plan/00-architecture-and-parametrization.md#the-four-config-artifacts).
Use the exact schemas from the LLM plan, add strict runtime validation, and pin the YAML parser
and version in the lockfile (the current package has no YAML dependency). Record
`gpt-5.6-sol` as a provisional observed identifier, but do not activate it or select a judge
family until P2/P3 and all rate-table entries are confirmed. The existing Anthropic provider is
available for evaluation; provider independence still requires an explicit model-family check.

---

## 8. Changelog (phase gate sign-offs go here)

- **2026-09-09 — prompt and dataset routing hardened.** Added the explicit production
  dataset manifest (`config/datasets.yaml`), made materialization honor `config/run.yaml`'
  selected tracks, and stopped unknown reading tracks from silently returning empty data.
  The rebuilt evidence judge now loads the rubric pack from the payload's configured track
  and refuses stale, unconfirmed, or blocker-covered dataset manifests. No legacy prompt or
  local fixture dataset is used by this path; missing production coverage remains
  `NO RECOMMENDATION`.

- **2026-09-09 — Phases 4–6 implementation complete; live execution gates intentionally
  fail closed.** Generalized rubric/prompt assembly across all 17 tracks, added the
  machine-readable 31-key supplementary metric register, and added deterministic checks
  for tarot card orientation, My Day dates/astronomy/activity contracts, chart aspect and
  house claims, compatibility score/prose coherence, static-score exact values/coverage,
  and zodiac sign facts/unknown-celebrity abstention. Added `npm run phase456:verify`, which
  passes planted-defect checks for the Phase 4–6 gates. The external champion model,
  production corpus reconciliation, and CosmicGuidance zodiac router verification remain
  open, so no paid run or all-17-track recommendation is fabricated; `zodiac_profile` is
  explicitly blocked until its external route is verified.

- **2026-09-08 — production cleanup pass.** Removed three unreferenced one-off scripts
  (`scripts/_cb001-cost-aggregate.ts`, `scripts/_check-latest-batch-error.ts`, and
  `scripts/remove-cb001-missing-batch.ts`). Kept active operational scripts, legacy
  service routes still used by the current dashboard/worker, datasets, migrations, and
  named run artifacts. Hardened the container context so runtime `config/` and the
  canonical prompt sources are shipped, disabled Express fingerprinting, and stopped
  readiness responses from exposing database error details.

- **2026-09-08 — Phases 1–3 implementation complete; execution gates intentionally not
  claimed.** Added the canonical numerology prompt composer and generated evidence schema,
  native structured-output judge adapters for Anthropic/OpenAI/Gemini, cache metadata,
  bounded post-parse validation with verbatim candidate/reference quote checks, resolved
  input-reference checks, absence checks, hard-gate enforcement, abstention semantics, and
  one same-request validation retry. Added idempotent `eval_judgements_v2` persistence.
  Added paired user-cluster bootstrap, paired deltas, Wilson bounds, composite quality,
  BH correction, cost accounting, ICC/design-effect/effective-n diagnostics, discrimination
  and redundancy primitives, self/cross-judge comparison, contamination verdicts, review
  import, sanity-floor checks, and the seven-report/eight-audit report bundle scaffold.
  `npm run phase123:verify` passes 6/6 deterministic Phase 1–3 gates, including all 142
  synthetic numerology cases and planted corruption/effect checks; the full repository
  suite passes 72/72, `tsc`, build, and Drizzle checks pass. This is an implementation
  sign-off, not a paid-run sign-off: `config/models.yaml` still has unresolved provider,
  model, and rate entries, so no external judge call or cache-hit claim is fabricated.
  The required 142-case live run, billing reconciliation, real cross-judge measurements,
  and human Report 7 signatures remain blocked by those inputs and are fail-closed.

- **2026-09-08 — Phase 0, partial (not a gate pass).** Landed a slice that does not
  depend on the open §1.5 blockers: `server/core/contracts/` (the 5 ports +
  `RenderedContent`/`Row`; `Judgement` deliberately has no apply/commit field per
  rule #6), the two boundary tests (`test/boundary/dependency-direction.test.ts`,
  `test/boundary/domain-vocabulary.test.ts`), `config/{models,thresholds,run,blockers}.yaml`
  with strict zod schemas and a fail-closed loader (`server/core/config/`), and a
  machine-readable `config/blockers.yaml` mirroring §1.5 with `assertNotBlocked()`.
  Also fixed the §1.2 test-baseline issue: `npm test` was crashing before test
  discovery because Windows `cmd.exe` doesn't glob-expand `*.test.ts` for `tsx`, and
  no test entry point loaded `.env`; `scripts/run-tests.mjs` now expands globs in
  Node and preloads `dotenv/config`. Real baseline as of this commit: 40/40 tests
  pass, `tsc --noEmit` clean, `npm run datasets:validate` clean.
  **Not done and not claimed done:** the `Datasource`/`Renderer`/`Stratifier`
  adapter implementations, the row materializer, and the `eval_rows`/`eval_model_map`/
  `eval_run_manifests` migrations — all of §1.5's blockers (silver source, partner
  coverage, champion confirmation, corpus reconciliation) are still open and still
  block those specifically. The Phase 0 exit gate in §5 is not met yet.

- **2026-09-08 — Phase 0, track registry.** Authored all 17 `config/tracks/*.yaml`
  (see `config/tracks/README.md`) from the plan's own 17-track table
  ([README.md#scope-the-17-tracks](./LLM%20PLAN/README.md#scope-the-17-tracks)) and
  the CG table names verified in §1.4 — no fabricated columns; anything unconfirmed
  (e.g. exact `tarotReadings`/`compatibilityReadings` output columns) is left out
  rather than guessed. Extended `server/core/config/schema.ts` with `trackSpecSchema`
  (`status: active | blocked`, `blockedReason`) and `loadTrackSpecs()` in
  `server/core/config/loader.ts`, which cross-checks every track's `status` against
  `config/blockers.yaml` and throws if they disagree. 8 of 17 tracks are `blocked`
  (numerology ×2 on `numerology-silver-source`; synastry/composite/number_compatibility
  ×2 each on `partner-coverage-policy`) — this reconciles the plan's row arithmetic
  (`test/unit/track-specs.test.ts` asserts 27 rows/user, numerology contributing 12)
  without touching the six-track `EvalTrack` DB enum, so it doesn't trip the §1.5
  registry-reconciliation blocker. Baseline: 44/44 tests pass, `tsc --noEmit` clean.
  Still not done: the adapters that would actually read these tables, and therefore
  no `rows.jsonl` yet — config authoring only.

- **2026-09-08 — `partner-coverage-policy` closed; §1.5's "5 actors have no
  partner" premise corrected.** Queried `JUDGE_DATABASE_URL` directly (this repo's
  own eval DB, not CosmicGuidance's — no boundary violation) at the user's
  direction. Findings: `eval_dataset_cases` has 100/100 actors covered for
  `synastry`, `composite`, and `number_compatibility` (200 rows each,
  brief+detailed); actors `cb-actor-002`..`cb-actor-005` have real, distinct named
  partners (e.g. `cb-actor-002` / "Amala Akkineni"), not placeholders — only
  `cb-actor-001` uses an explicit `supplied-partner-...` record. This contradicts
  §1.1/§1.2/§1.5's claim (traced to `prepare-cg-batch-corpus.ts`'s `> 5` guard,
  which excludes the workbook partner column for actor numbers ≤ 5) that 5 actors
  have no compatibility data; whatever produced these DB rows evidently didn't go
  through that guard. **§1.1, §1.2, and §1.5 above still say "5 actors have no
  partner" and have not been edited — treat that specific claim in this document as
  superseded by this entry, not as current.** Action taken: `partner-coverage-policy`
  in `config/blockers.yaml` marked `closed` (with `closedBy`/`closedReason`
  recording how); `synastry_brief/detailed`, `composite_brief/detailed`,
  `number_compatibility_brief/detailed` flipped to `status: active` in
  `config/tracks/`; tests updated. Baseline: 44/44 tests pass, `tsc` clean.
  **`numerology-silver-source` was NOT closed** despite candidate generations
  existing for all 100 actors: `eval_dataset_cases.gold_output` is null on all
  1,204 numerology rows and `eval_reference_generations` has only 14 rows, all for
  `cb-actor-001` — candidate/challenger output is not a silver reference, and
  rule #8 (fail closed on missing silver) applies. `champion-model-confirmation`
  and `production-corpus-reconciliation` also remain open — the DB confirms
  `gpt-5.6-sol` was run with `provider: openai` on some rows and that the
  `cg-production-batch-only-20260828` corpus is already imported, but neither is
  the same as the formal confirmation/reconciliation those blockers require.
  No adapter/materializer work was done this entry — config and blocker-registry
  reconciliation only, per explicit instruction.

- **2026-09-08 — `numerology-silver-source` closed as a policy decision.** User
  decided this evaluation will not use a separate silver/gold reference dataset for
  any track — the candidate readings already generated and stored (in this
  service's own DB: `eval_dataset_cases`, `eval_generations`, model `gpt-5.6-sol`,
  covering all 100 actors) are the final dataset, judged directly by the rubric.
  This is compatible with the given plan: `docs/LLM PLAN/02-metric-suite/
  02-silver-similarity-metrics.md` specs the 4 comparative metrics as appended only
  when `prompt.includeSilverReference: true` — never a requirement of the core
  universal + reading-specific rubric metrics. Action: `config/blockers.yaml`
  "numerology-silver-source" → `closed`; `config/models.yaml`
  `includeSilverAsBlindArm: false`; `numerology_brief`/`numerology_detailed` →
  `status: active` in `config/tracks/`. **All 17 tracks are now `active`** — no
  config-level blocker remains on any track. **Explicitly out of scope for this
  entry, per direct instruction:** `eval_dataset_cases.gold_output` and the
  `eval_reference_generations` table were NOT touched. Those are a separate, older
  concept still used by the currently-running legacy admin dashboard and the
  `cb-actor-001` benchmark scripts — removing them is a §6 cutover action, not a
  Phase 0 config change, and doing it now would break currently-working features.
  `champion-model-confirmation` and `production-corpus-reconciliation` remain open.
  Baseline: 44/44 tests pass, `tsc` clean.

- **2026-09-08 — real (non-fixture) `Datasource`/materializer built against the
  already-imported corpus; first real `rows.jsonl`.** With all 17 tracks active,
  built the actual Phase 0 stage-1 pipeline against `JUDGE_DATABASE_URL` (not a live
  CosmicGuidance connection — this service's own DB, already holding the imported
  candidate corpus):
  - `server/adapters/cosmic-guidance/track-map.ts` — the single place that reconciles
    the DB's own `(track, reading_type, reading_subtype)` labelling against the 17
    TrackSpec keys (e.g. DB `track='numerology'` + 6 `reading_type` values → 2
    TrackSpec keys, stratified by `numberType`; DB `track='synastry'` + `reading_subtype`
    → `synastry_brief`/`synastry_detailed`). A unit test cross-checks every active
    TrackSpec key is covered here or in `TRACKS_WITH_NO_DB_DATA`, so it can't drift.
  - `server/adapters/cosmic-guidance/datasource.ts` — real `Datasource` port
    implementation. `listUsers()` scans small columns only; `fetchRows(track, users)`
    is scoped to exactly one TrackSpec key's DB rows, never "fetch everything."
  - `server/adapters/cosmic-guidance/materialize.ts` — stage-1 materializer producing
    `runs/<runId>/rows.jsonl` + `modelmap.sealed.json`. Renderer/Stratifier ports are
    **not** implemented — per the plan's own stage table, stage 1 doesn't call
    Renderer, and stratum falls out of the same DB lookup as track resolution, so a
    separate Stratifier class would be two functions doing one lookup for this
    adapter. Every row carries `provenance: { championModelConfirmed,
    productionCorpusConfirmed }` computed from `config/blockers.yaml` — the two still-open
    blockers are now a visible per-row flag, not just a doc a reader has to go find.
  - **Real finding, not a bug:** `synastry`, `transit`, `natal`, `composite`, and
    `zodiac_profile` store ~400-500KB of chart/ephemeris JSON per `input_snapshot`
    row (verified: `avg(pg_column_size(input_snapshot))` ≈ 140-160KB TOAST-compressed).
    An early version of the datasource fetched the whole corpus in one query and
    appeared to hang for 5+ minutes — it was TOAST-decompressing ~900 large rows
    serially, not stuck. Fixed by scoping every query to one TrackSpec key at a time
    (bounds each call to ~100-200 rows); a full 100-user, 17-track materialize run
    still takes on the order of 10-20 minutes of real wall-clock and should be run as
    a background/batch job, not expected to return instantly.
  - Filtering is by `model = 'gpt-5.6-sol'`, not `arm` — `eval_generations` also
    contains unrelated `baseline-model-v1`/`candidate-model-v1` mock-provider test
    rows with `arm = 'baseline'`/`'candidate'` from other test suites; an early draft
    filtered by `arm` and would have silently matched the wrong 16 rows instead of
    the real 2,586.
  - Confirmed while building this: `numerology` and `zodiac_profile` are missing
    candidate data for exactly 1 of 100 actors each (99/100, not 100/100) — reported
    honestly via row counts, not padded.
  - Tests: `test/unit/track-map.test.ts` (pure, no DB) and
    `test/integration/cosmic-guidance-materialize.test.ts` (real DB, scoped to 3
    sample users so it runs in under a minute instead of the full run's 10-20).
    Verifies row uniqueness, non-null `userId`, and that the observed model string
    never appears in `rows.jsonl` content (blinding). Baseline: 56/56 tests pass,
    `tsc` clean.
  - Not done: `Renderer` implementations, `payloads.jsonl` (stage 2), the judge
    client wiring, and the `eval_rows`/`eval_model_map`/`eval_run_manifests` DB
    migrations from §4 — this entry is stage 1 (materialize) only.

- **2026-09-08 — Phase 0, render/preflight slice (not a gate pass).** Added the
  product-neutral render orchestration in `server/core/pipeline/` and the adapter-owned
  deterministic renderer in `server/adapters/cosmic-guidance/renderer.ts`. It produces
  stable, addressable fields, ordered sections, and removes SVG/data-image blobs before
  any judge payload is written. Added `render:cosmic-guidance` and `estimate`; the latter
  runs only materialize/render and reports unknown cost when the approved rate table is
  absent. Materialization now writes `coverage.json` with explicit `NO RECOMMENDATION`
  for empty/partial tracks, an immutable `modelmap.sealed.json`, and a stage manifest.
  Added the Phase 0 artifact tables and migration (`eval_silver_outputs`, `eval_rows`,
  `eval_model_map`, `eval_judgements_v2`, `eval_run_manifests`). `run.yaml` now declares
  all 17 tracks and disables silver-reference rendering to match the recorded policy.
  Tests: `npm run check`, unit tests, boundary tests pass; the integration materializer
  was rerun after fixing semantic idempotency for an existing sealed-map JSON file.
  **Still not done:** fixture adapter/17-track fixture cardinality gate, provider judge,
  evidence validator, statistics, and a formal Phase 0 sign-off.

- **2026-09-08 — Phase 0 gate passed.** Added the test-only fixture adapter
  and contract gate in `test/fixtures/phase0-fixture.ts` and
  `test/unit/phase0-gate.test.ts`: all 17 tracks materialize to exactly 27 rows/user,
  including six rows per numerology depth; all five ports are exercised; core runs with
  only its contracts and injected ports; payload blinding, renderer image sanitization,
  addressable fields/sections, and per-track estimates are asserted. The generic core
  materializer is now shared by the production adapter and fixture gate. `npm test`
  passes 66/66, `tsc`, build, and `drizzle-kit check` pass. The exact
  `migrations/0006_rebuild_artifacts.sql` migration is applied to `JUDGE_DATABASE_URL`; a
  live schema check confirms all five tables exist. Production materialization persists
  `eval_rows`, `eval_model_map`, and `eval_run_manifests` idempotently, while the file
  artifacts remain the stage hand-off. The open champion-model and production-corpus
  blockers still prevent paid evaluation and keep unsupported real-data tracks at
  `NO RECOMMENDATION`; they are Phase 1/paid-run prerequisites, not a Phase 0 scaffold
  failure.
