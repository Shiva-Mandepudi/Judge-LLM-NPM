# Cosmic Guidance Evaluation System

An **offline, batch** LLM-as-Judge harness that scores challenger model outputs against a
**silver reference**, produces evidence-grounded metrics, rolls them up per reading and
per user, and lands a statistically robust, cost-aware model decision **per reading**.

Built as a **separate repo**. Modularity, parametrization and scalability are core design
constraints, not afterthoughts — the engine must know nothing about astrology so it can be
pointed at future Shunyaverse products by adding config, not code.

> **Silver, not gold.** The reference dataset is frontier-model-generated and
> human-reviewed. It is a *high-quality reference, not ground truth*. Similarity to silver
> is one reported axis in the decision — never the objective function. A challenger that
> genuinely beats silver must be able to score as such.

---

## The three deliverables

| # | Deliverable | Location |
|---|---|---|
| 1 | **Judge Prompt (hybrid)** — universal kernel + per-reading rubric packs | [01-judge-prompt/](01-judge-prompt/) |
| 2 | **Metric Suite (hybrid)** — universal + reading-specific + silver-similarity | [02-metric-suite/](02-metric-suite/) |
| 3 | **Build plan** — architecture, phases, statistics, cost, reporting | [03-build-plan/](03-build-plan/) |

### File index

```
01-judge-prompt/
  00-universal-kernel.md        the shared judge prompt (verbatim text)
  01-output-contract.md         judge output JSON schema + abstention semantics
  rubric-packs/
    natal.md  transit.md  synastry.md  composite.md
    number-compatibility.md  numerology.md  tarot.md
    my-day.md  static-scores.md  zodiac-profile.md
02-metric-suite/
  00-universal-metrics.md         8 universal metrics (3 hard gates)
  01-reading-specific-metrics.md  31 per-track supplements (9 hard-gate keys)
  02-silver-similarity-metrics.md 4 comparative metrics
03-build-plan/
  00-architecture-and-parametrization.md  core/adapters split, ports, config, scalability
  01-build-phases.md            9 phases with exit gates
  02-statistical-design.md      cluster bootstrap, CIs, decision support
  03-cost-analysis.md           per-reading, per-user, judge cost, quality-per-dollar
  04-reporting-and-human-review.md  7 decision reports + 8 component audits
```

**Suite totals** — configuration, docs and reports must agree on these, and
[Audit 5](03-build-plan/04-reporting-and-human-review.md#audit-5--metrics) fails the build if
they drift:

| | Universal | Reading-specific | Comparative | **Total** |
|---|---|---|---|---|
| Distinct metric keys | 8 | 31 | 4 | **43** |
| Distinct hard gates | 3 | 9 | 0 | **12** |

Reading-specific keys total 31 distinct across **37** track-metric assignments, because five
keys are deliberately shared between tracks; 11 of those assignments are hard gates.

---

## Pipeline

```
  Silver Reference          Challenger Outputs         Reading Definitions
  (DB table)                (DB table)                 (17 track configs)
  frontier-gen +            same readings,             universal kernel +
  human-reviewed            same users, per model      rubric pack per reading
        │                          │                          │
        └──────────┬───────────────┘                          │
                   ▼                                          │
          Row materialization  ◄─────────────────────────────-─┘
          one row = (user, track, stratum, model)
                   │
                   ▼
          ┌─────────────────────┐
          │   Hybrid Judge LLM  │  kernel + rubric pack, one call per row
          │  evidence-gated     │  cannot score without evidence → abstain
          └─────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
  Quality / Safety /    Silver Similarity
  Usefulness metrics    metrics (similarity ≠ truth)
        └──────────┬──────────┘
                   ▼
        Per-Reading Metrics  (core + reading-specific + cost/reading)
                   ▼
        Per-User Rollup      (all readings for a user; total cost per user)
                   ▼
        Statistical Analysis (CIs, paired deltas vs champion,
                              CLUSTER BOOTSTRAP BY USER)
                   ▼
        Human Audit Slice    (calibrate judge, spot-check reasoning, edge cases)
                   ▼
        REPORT BUNDLE        7 decision reports + 8 independent component audits
                   ▼
        ┌──────────────────────────────────────────────┐
        │  HUMAN DECISION  — the engine recommends,    │
        │  a human decides. Per track: accept /        │
        │  override / defer, reason recorded.          │
        │  quality · safety · silver similarity ·      │
        │  cost efficiency · statistical robustness    │
        │  → best quality-per-dollar, per reading      │
        └──────────────────────────────────────────────┘
```

**Nothing ships on a computed threshold.** Every threshold in `thresholds.yaml` is a
product-value judgement, so the engine produces a *recommendation* plus a
threshold-sensitivity table, and each of the eight components — dataset, prompts, judge,
evidence, metrics, statistics, cost, gates — is auditable **independently**, without taking
any of the others on trust. See
[03-build-plan/04](03-build-plan/04-reporting-and-human-review.md).

---

## Scope: the 17 tracks

Selection rule applied: **cleanly mapped to a single owning user**, LLM-generated, and live.

| # | Track key | Depth | Strata | Rows/user |
|---|---|---|---|---|
| 1 | `natal_brief` | B | chart complexity, birth-time known | 1 |
| 2 | `natal_detailed` | D | " | 1 |
| 3 | `transit_brief` | B | chart complexity, season | 1 |
| 4 | `transit_detailed` | D | " | 1 |
| 5 | `synastry_brief` | B | partner archetype | 1 |
| 6 | `synastry_detailed` | D | " | 1 |
| 7 | `composite_brief` | B | " | 1 |
| 8 | `composite_detailed` | D | " | 1 |
| 9 | `number_compatibility_brief` | B | master-number present | 1 |
| 10 | `number_compatibility_detailed` | D | " | 1 |
| 11 | `numerology_brief` | B | **`numberType` × 6** | 6 |
| 12 | `numerology_detailed` | D | **`numberType` × 6** | 6 |
| 13 | `tarot_brief` | B | spread type, reversed count, question present | 1 |
| 14 | `tarot_detailed` | D | " | 1 |
| 15 | `my_day` | — | day-of-week, moon phase, season | 1 |
| 16 | `static_scores` | — | chart complexity | 1 |
| 17 | `zodiac_profile` | — | sun sign | 1 |

**Row arithmetic:** 27 rows per user (numerology contributes 12). At 100 users that is
**2,700 rows per model**; with the champion plus *k* challengers, `2,700 × (k+1)` judged rows.
Both `users` and `rowsPerTrack` are config — see [03-build-plan/00](03-build-plan/00-architecture-and-parametrization.md).

`compatibility_readings` carries `userId` + `person1Id` + `person2Id`
([shared/schema.ts:915](shared/schema.ts#L915)) — the row belongs to **one** user, the partner
is a `persons` record. So the cluster unit is the user for all 17 tracks, with no exceptions.

### Excluded, and why

| Excluded | Reason |
|---|---|
| `contextual_chat` | Deferred by decision. Also the only multi-turn track — needs a conversation-level row shape, not a per-row one. |
| `profile_image` | Deferred by decision. Image modality; needs a vision rubric + human gate. |
| `cosmic_answers` | Designed but not built (`plan/design-cosmic-answers-paid-question-reports.md`). Add as track 18 when it ships. |
| 8 free "on-the-fly" tools | Deterministic client-side math over static copy catalogs. Zero LLM. |
| Daily tarot card, canonical 36-field static profile | Pre-authored content and pure TypeScript calculators. |
| 36 static elements (`ChatGPTAstrologyCalculator`) | **Zero callers** repo-wide — orphaned code path. |
| `journal_insight`, `life_event_insight`, `tarot-daily`, `tarot-three-card`, `tarot-celtic-cross`, `cosmic-coach` | Wired but non-functional: no seeded prompt template, or seeded at `subscription_tier:"free"` while live tiers are `stardust\|moonbeam\|starstruck`, so lookup fails and the error is swallowed. Filed as defects, not tracks. |

---

## Two decisions taken as given

**No pre-judge checks — LLM checks only.** There is no deterministic gate stage. Schema
validity, completeness, truncation and safety are **judged metrics with evidence**
(`structural_completeness`, `safety_compliance`), not machine assertions. Consequences,
accepted: judge tokens are spent on outputs a regex would have rejected, and format
verdicts inherit judge variance rather than being exact. Cost impact is quantified in
[03-build-plan/03](03-build-plan/03-cost-analysis.md).

*Mechanical exception, not a quality check:* a stored output that will not parse cannot be
placed in a judge payload at all. Such rows are recorded with `loadStatus: "unparseable"`
and reported as a rate per (track, model). That is a load failure, not an evaluation.

**Champion.** The incumbent is stated as **`5.6 sol`** — recorded verbatim; the exact model
ID must be filled into `config/models.yaml` before the first run. All paired deltas are
computed against the champion.

> **Judge-independence consequence.** The judge must not be the same model or model family
> as any member of the candidate pool — a model rates outputs resembling its own style more
> favourably, and here that bias would land directly on the champion. Once the champion's
> exact family is confirmed, pick the primary judge from a **different vendor family**. The
> selection rule and the cross-vendor agreement check are in
> [03-build-plan/02](03-build-plan/02-statistical-design.md#4-judge-reliability).

---

## Reusability

The repo is split so the evaluation engine is product-agnostic and CosmicGuidance knowledge is
confined to an adapter:

- **`packages/core`** — judging, evidence validation, scoring, statistics, cost, audits,
  reports. Knows about rows, metrics, gates and clusters. Knows nothing about astrology.
- **`packages/adapters/cosmic-guidance`** — datasource, renderers, strata, the 17 track
  configs and the rubric packs.

`core` never imports from `adapters`, enforced in CI. A new ShunayaVerse product is a new
adapter plus config; the kernel, the 8 universal metrics, the 4 comparative metrics, the whole
evidence contract, the statistics and every report carry over untouched. Details in
[03-build-plan/00](03-build-plan/00-architecture-and-parametrization.md#the-core--adapters-split).

## Reading order

1. This file — scope and shape.
2. [01-judge-prompt/00-universal-kernel.md](01-judge-prompt/00-universal-kernel.md) — the kernel is the contract every rubric pack extends.
3. [02-metric-suite/00-universal-metrics.md](02-metric-suite/00-universal-metrics.md) — what the kernel scores.
4. [03-build-plan/02-statistical-design.md](03-build-plan/02-statistical-design.md) — why the row shape is what it is.
5. [03-build-plan/04-reporting-and-human-review.md](03-build-plan/04-reporting-and-human-review.md) — what you will actually be handed, and what you are asked to decide.
6. Everything else on demand.
