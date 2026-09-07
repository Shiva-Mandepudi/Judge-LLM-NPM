# Rubric Pack — Synastry Compatibility

| | |
|---|---|
| Track keys | `synastry_brief`, `synastry_detailed` |
| Silver + challenger source | `compatibility_readings` where `readingType='synastry'` |
| Input field | `compatibility_readings.chartDetails`, reduced to `{planets, houses, aspects, ascendant, mc}` before prompting ([compatibilityInsightService.ts:388](server/services/compatibilityInsightService.ts#L388)) |
| Strata | partner archetype (harmonious / challenging / mixed) |
| Cluster unit | the owning `userId` — the partner is a `persons` row, not a second user |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Synastry Compatibility Reading ({{depth}})

An interpretation of the relationship dynamic between two people's charts, with a numeric
compatibility score per life area. Two people read this together, so fairness between them
is part of the product.

Ten fixed sections:
Emotional Bond & Understanding · Communication & Mental Connection ·
Romantic Attraction & Chemistry · Long-Term Commitment & Stability ·
Shared Values & Finances · Growth, Learning & Life Purpose ·
Power, Control & Transformation · Daily Life & Routine Compatibility ·
Spiritual & Creative Union · Overall Compatibility

Expected structure: each of the first nine has a key theme, strengths together, challenges
together, growth advice, a 0–100 score, and an affirmation. `Overall Compatibility` carries
a score and a summary. Detailed prose runs roughly 100–150 words per sub-section.

## HOW TO READ THE INPUT DATA

INPUT DATA is the combined synastry chart:
- `planets` — both people's placements
- `aspects` — inter-chart contacts (person A's planet to person B's planet)
- `houses`, `ascendant`, `mc`

The inter-chart entries in `aspects` are the substance of synastry. Cite as
`aspects[<personA body>-<personB body>]`.

## WHAT GROUNDED MEANS HERE

- A named inter-chart aspect must exist in `aspects`. Invented contacts fail
  `input_grounding`.
- Synastry is about *contacts between* the charts. A reading that describes each person
  separately and never addresses the interaction has not produced a synastry reading — score
  that under `bidirectional_fairness`, not grounding.
- The numeric scores are the model's own judgement, not input data, so they cannot be
  checked for factual truth. They can be checked for coherence with the prose — see
  `score_narrative_coherence`.

## SUPPLEMENTARY METRICS

bidirectional_fairness
  Does the reading describe a mutual dynamic, or does it centre one person and treat the
  other as context? Does it avoid assigning blame for the hard aspects to one party? Score 5
  when both people's contributions to each dynamic are visible and neither is cast as the
  problem; score 2 or below when one person is consistently the subject and the other the
  object, or when a hard aspect is framed as one person's fault.

score_narrative_coherence
  Does each 0–100 score match the prose in its own section? A section scoring 88 whose prose
  is mostly difficulty, or scoring 35 whose prose is warm and untroubled, is incoherent —
  and that mismatch is what a reader notices first. Also check `Overall Compatibility`
  against the nine section scores: an overall of 90 above a set of scores averaging in the
  fifties is a failure. Score on the consistency of the set, and cite the specific mismatch.

challenge_honesty
  Are the difficult contacts named and dealt with, or smoothed into vagueness? This product
  is affirming by design, but a compatibility reading that cannot say anything hard is not
  useful. Score 5 when challenges are stated plainly and paired with something actionable;
  score 2 or below when the challenge fields are empty of real content.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `bidirectional_fairness` | soft | |
| `score_narrative_coherence` | soft | catches the highest-visibility defect on this track |
| `challenge_honesty` | soft | |
