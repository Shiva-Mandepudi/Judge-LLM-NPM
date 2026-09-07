# Rubric Pack — 17 Static Astrology Scores

| | |
|---|---|
| Track key | `static_scores` |
| Silver + challenger source | `user_scores.scoreInsights` where `scoreType='static'` |
| Input | chart + 6 numerology numbers **+ 10 of the 17 score values pre-computed in TypeScript and injected as authoritative** |
| Strata | chart complexity |
| Production prompt | `prompts/astrology/Astrology_Static_Scores_1749258116290.md`, `temperature: 0.3` — the lowest in the product |
| Notable | has a strict inline `json_schema` covering all 17 scores |

**This track is structurally unlike every other.** Ten of the seventeen values are computed
deterministically by [server/services/deterministic-calculator.ts](server/services/deterministic-calculator.ts)
and injected into the prompt with the instruction *"Use these exact pre-calculated
values"* ([score-generation.ts:490](server/services/score-generation.ts#L490)). For those ten,
the model's job is **narration, not calculation** — so "grounded" means "did not alter the
number it was handed", which is an exact check.

The ten pre-computed: Elemental Dominance, Modality Balance, Zodiac Elemental,
Yin/Yang Polarity, Balance of Energies, Zodiac Compatibility, Elemental Compatibility,
Aspect Harmony, Chakra Alignment, Life Archetype Index.

The seven model-generated: Planetary Influence, Natal Chart Complexity Index,
Spiritual Alignment, Inner Power Index, Emotional Intelligence, Energy Balance Index,
Healing Affinity.

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — 17 Static Astrology Scores

Seventeen quantified "cosmic metrics", each with a value and four pieces of explanatory
text: a summary, an interpretation, a personalised insight, and an empowerment tip. The
reader sees these as measurements of themselves, so a wrong number is worse than weak prose.

All seventeen must be present:
Elemental Dominance · Modality Balance · Planetary Influence · Aspect Harmony ·
Yin/Yang Polarity · Zodiac Elemental · Natal Chart Complexity Index · Life Archetype Index ·
Chakra Alignment · Balance of Energies · Zodiac Compatibility · Elemental Compatibility ·
Spiritual Alignment · Inner Power Index · Emotional Intelligence · Energy Balance Index ·
Healing Affinity

Each carries a `value`, a `value_type` from
{percentage, balance, category, index, match, text}, and the four text fields.

## HOW TO READ THE INPUT DATA

INPUT DATA contains:
- `chartDetails` — the natal chart
- `numerology` — the six numbers
- `precomputedScores` — **ten score values already calculated and supplied to the writer as
  authoritative.** These are not the writer's to change.

Cite as `precomputedScores.<scoreName>`, `chartDetails.<field>`, `numerology.<field>`.

## WHAT GROUNDED MEANS HERE

Split the seventeen into two groups and judge them differently:

**The ten in `precomputedScores`.** The value must be reproduced exactly. Any alteration —
rounding, rescaling, restating as a different category, or quietly substituting a different
number — is a fabrication, because the reader is being shown a number that contradicts the
system's own calculation. This is an exact string/numeric comparison, not a judgement.

**The seven model-generated.** These have no authoritative value to check against, so they
cannot fail on value accuracy. Judge them on whether the value is defensible given
`chartDetails` and `numerology`, and on whether the narrative supports the number.

For all seventeen, the four text fields are interpretation and are judged on quality and on
consistency with the value they accompany — not on factual truth.

## SUPPLEMENTARY METRICS

injected_value_fidelity — HARD GATE
  For each of the ten scores present in `precomputedScores`, does the output value match the
  injected value exactly? Fail the gate on any mismatch, and name the score and both values
  in `violation`. Cite `precomputedScores.<scoreName>` in `inputRefs`. This is the single most
  important check on this track: the writer was explicitly told to use these values, so a
  deviation is instruction-following failure with direct user-visible consequences.

score_coverage — HARD GATE
  Are all seventeen scores present, correctly named, and non-duplicated? Fail the gate on a
  missing or duplicated score. Cite the missing name in `violation`.

value_type_correctness
  Is each `value_type` appropriate to its value? A percentage typed as `category`, or a
  qualitative label typed as `percentage`, breaks the rendering contract. Score on the
  consistency of the set.

score_interpretation_alignment
  Does each score's narrative match the direction and magnitude of its value? A 22%
  Elemental Dominance described as overwhelming strength, or an 89% Aspect Harmony described
  as a difficult chart, is the failure mode — and it is especially likely on the ten injected
  values, where the model receives a number it did not choose and must write around it.
  Score 5 when every narrative is consistent with its number; cite the worst mismatch.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `injected_value_fidelity` | **HARD** | exact comparison; unique to this track |
| `score_coverage` | **HARD** | all 17 present, named, unduplicated |
| `value_type_correctness` | soft | |
| `score_interpretation_alignment` | soft | the likeliest real defect |
