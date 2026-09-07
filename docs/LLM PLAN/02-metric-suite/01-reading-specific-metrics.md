# Reading-Specific Metrics

The per-track half of the hybrid suite. Full definitions live in each
[rubric pack](../01-judge-prompt/rubric-packs/); this is the consolidated map, the gate
register, and the aggregation rules.

## Complete register

| Track | Metric | Gate | Conditional on |
|---|---|---|---|
| `natal_*` | `aspect_coverage` | soft | |
| | `house_domain_accuracy` | soft | |
| `transit_*` | `transit_timing_relevance` | soft | |
| | `transit_natal_distinction` | soft | |
| | `timing_specificity` | soft | |
| `synastry_*` | `bidirectional_fairness` | soft | |
| | `score_narrative_coherence` | soft | |
| | `challenge_honesty` | soft | |
| `composite_*` | `union_entity_framing` | soft | |
| | `score_narrative_coherence` | soft | |
| | `challenge_honesty` | soft | |
| `number_compatibility_*` | `canonical_meaning_fidelity` | **HARD** | |
| | `master_number_handling` | **HARD** | a master number present in either person |
| | `number_pair_fidelity` | soft | |
| | `score_narrative_coherence` | soft | |
| `numerology_*` | `canonical_meaning_fidelity` | **HARD** | |
| | `master_number_handling` | **HARD** | `numberValue ∈ {11,22,33}` |
| | `number_type_discipline` | soft | |
| | `year_anchoring` | soft | `numberType = personal_year` |
| `tarot_*` | `card_fidelity` | **HARD** | |
| | `position_semantics` | soft | |
| | `spread_coherence` | soft | |
| | `question_responsiveness` | soft | |
| `my_day` | `date_correctness` | **HARD** | |
| | `astronomical_accuracy` | **HARD** | |
| | `cross_section_coherence` | soft | |
| | `transit_timing_relevance` | soft | |
| | `activity_validity` | soft | |
| | `numerology_day_integration` | soft | |
| `static_scores` | `injected_value_fidelity` | **HARD** | |
| | `score_coverage` | **HARD** | |
| | `value_type_correctness` | soft | |
| | `score_interpretation_alignment` | soft | |
| `zodiac_profile` | `sign_attribute_accuracy` | **HARD** | |
| | `famous_people_plausibility` | **HARD** | |
| | `archetype_coherence` | soft | |
| | `cultural_care` | soft | |

### Register totals — authoritative

These are the numbers configuration and reports must agree with. They are derived from the
table above, and a test recomputes them from `config/metrics.yaml` and fails on drift.

| Count | Value |
|---|---|
| Track-metric assignments (rows in the table above) | **37** |
| **Distinct** supplementary metric keys | **31** |
| **Distinct** supplementary hard-gate keys | **9** |
| Hard-gate assignments (track × gate) | **11** |
| Keys shared across more than one track | **5** |
| Supplements per track | **2 – 6** |

Whole-suite totals, including the universal and comparative sets:

| Count | Universal | Supplementary | Comparative | **Total** |
|---|---|---|---|---|
| Distinct metric keys | 8 | 31 | 4 | **43** |
| Distinct hard gates | 3 | 9 | 0 | **12** |

Distinct keys (31) is less than assignments (37) because **five keys are intentionally shared
across tracks**, measuring the same thing in each:

| Shared key | Tracks | Gate |
|---|---|---|
| `score_narrative_coherence` | synastry, composite, number-compatibility | soft |
| `canonical_meaning_fidelity` | number-compatibility, numerology | **hard** |
| `master_number_handling` | number-compatibility, numerology | **hard** |
| `transit_timing_relevance` | transit, my_day | soft |
| `challenge_honesty` | synastry, composite | soft |

Shared keys are defined **once** in `config/metrics.yaml` and referenced by each pack, so a
definition cannot drift between packs. A metric's per-track guidance may differ; its
definition and gate class may not.

## Design rules these follow

1. **Non-overlapping with the universal set.** No supplement re-scores what a universal
   metric already covers. `input_grounding` owns fabrication; supplements own coverage,
   domain mapping, and track-specific correctness classes. A defect must land in exactly one
   metric, or the composite double-counts it.
2. **Every hard gate is anchored to something exactly checkable.** Each of the 10 gates has a
   determinate right answer available in the input — the injected score value, the card
   orientation, the sign's ruling planet, the master-number set, the target date. None is a
   matter of taste. Gates that rest on judgement are unfalsifiable and become noise.
3. **Conditional metrics abstain, they do not score zero.** `master_number_handling` on a
   life-path 7 returns `metric_not_applicable`. This is why abstention is a first-class
   output rather than an error condition — four of the metrics above are conditional by
   construction.
4. **Every supplement names a concrete failure mode observed in this codebase.** They are
   derived from the actual prompts and the actual output structures, not from a generic
   quality checklist.

## Where the gates concentrate

Hard gates cluster on exactly the tracks where content is permanent, publicly falsifiable,
or contradicts the system's own computation:

| Track | Gates | Why concentrated here |
|---|---|---|
| `numerology_*` | 2 | content is generated once and served to **every future reader** with that number — an error does not average out, it compounds indefinitely |
| `static_scores` | 2 | 10 values are computed in TypeScript and injected; altering one shows the reader a number that contradicts the system |
| `zodiac_profile` | 2 | the most-shared artifact; sign attributes and celebrity birthdays are checkable by anyone |
| `my_day` | 2 | seen daily; moon phase and date are trivially falsifiable |
| `number_compatibility_*` | 2 | shares numerology's two gates — the numbers are the entire input, so canonical meaning and master-number handling are exactly checkable |
| `tarot_*` | 1 | the deck's canonical meanings are supplied in the input, so orientation errors are exact |

`natal`, `transit`, `synastry` and `composite` carry **no** track-specific hard gates — their
factual surface is fully covered by the universal `input_grounding` gate, and everything
beyond it is interpretation. Adding a gate there would be gating taste.

## Aggregation

Supplements are **not** folded into `composite_quality`. Three reasons:

1. `composite_quality` must mean the same thing on all 17 tracks for the per-user rollup and
   the consolidated report to be meaningful. Tracks carry between 2 and 6 supplements; mixing
   them in makes the composite a different quantity per track.
2. Supplements are where the actionable diagnosis lives. Averaged into a single number, the
   finding "model X reverses tarot card orientations" disappears.
3. Four supplements are conditional, so their denominators differ by row. A composite with a
   varying denominator is not comparable across rows.

Instead:

| Level | What is computed |
|---|---|
| Per (track, model), per supplement | mean + cluster-bootstrap CI + abstention rate + evidence-channel mix |
| Per (track, model) | `track_supplement_mean` — unweighted mean of that track's **soft** supplements, reported beside `composite_quality`, never merged into it |
| Per (track, model), per gate | failure rate + CI |
| Per user | universal metrics and `composite_quality` only — supplements are not comparable across a user's 17 tracks |
| Consolidated | universal metrics and gate rates across tracks; supplements listed per track as diagnostics |

The decision rule reads `composite_quality`, the gate rates, `track_supplement_mean`, and
cost — as four separate inputs. It never collapses them into one scalar before the decision.
See [03-build-plan/02](../03-build-plan/02-statistical-design.md#6-decision-support--what-the-engine-computes-who-decides).

## Adding a track

The whole point of the hybrid split. To add a track — including a non-CosmicGuidance one:

1. Write `prompts/rubric-packs/<track>.md`: reading type, how to read the input, what
   grounded means, supplementary metric definitions.
2. Declare the metric keys and gate flags in `config/tracks/<track>.yaml`.
3. Add a datasource query and a renderer for the input and output shapes.

No engine change. The universal metrics, output schema generation, statistics and cost
rollups all apply unchanged — that is the scalability property this design is buying.
