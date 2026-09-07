# Rubric Pack — Composite Compatibility

| | |
|---|---|
| Track keys | `composite_brief`, `composite_detailed` |
| Silver + challenger source | `compatibility_readings` where `readingType='composite'` |
| Input field | reduced `chartDetails` as for synastry |
| Strata | partner archetype |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Composite Chart Reading ({{depth}})

A composite chart merges two charts into a single third chart representing the relationship
itself. The reading interprets that relationship as its own entity with its own character —
not as two people being compared.

Ten fixed sections:
Union Identity & Purpose · Emotional Bond & Needs · Communication & Shared Ideas ·
Passion, Drive & Action · Affection & Harmony · Shared Values & Resources ·
Career, Public Life & Legacy · Daily Routines & Well-Being ·
Spiritual Growth & Transformation · Overall Compatibility

The first sub-section of each is a Union Theme. Structure otherwise matches synastry: union
theme, strengths, challenges, growth advice, score, affirmation.

## HOW TO READ THE INPUT DATA

INPUT DATA is the composite chart: `planets`, `houses`, `aspects`, `ascendant`, `mc`. These
are composite midpoints — a single set of positions belonging to the relationship, not two
sets belonging to two people. Cite as `planets.<body>` and `aspects[<a>-<b>]`.

## WHAT GROUNDED MEANS HERE

- Named composite placements and aspects must exist in the input. Fabrication fails
  `input_grounding`.
- The most common conceptual error on this track is treating the composite as a synastry
  reading — describing "your Venus and their Mars" when the input has one merged Venus and
  one merged Mars. That is both a grounding failure (those separate placements are not in
  the input) and a framing failure. Mark it under `input_grounding` when specific
  non-existent per-person placements are named, and under `union_entity_framing` when the
  framing is wrong without inventing data.

## SUPPLEMENTARY METRICS

union_entity_framing
  Does the reading speak about the relationship as a single entity with its own identity,
  needs and trajectory? Score 5 when the voice is consistently about "the relationship";
  score 2 or below when it reads as a two-person comparison, which is the wrong product.

score_narrative_coherence
  As for synastry: each section's 0–100 score must match its prose, and
  `Overall Compatibility` must be consistent with the nine section scores. Cite the mismatch.

challenge_honesty
  Are the composite chart's hard configurations addressed with real content, or smoothed
  into vagueness?
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `union_entity_framing` | soft | the defining check for this track |
| `score_narrative_coherence` | soft | |
| `challenge_honesty` | soft | |
