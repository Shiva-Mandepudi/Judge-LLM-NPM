# Rubric Pack — Natal Chart

| | |
|---|---|
| Track keys | `natal_brief`, `natal_detailed` |
| Silver + challenger source | `natal_charts.briefInsight` / `.detailedInsight` (jsonb) |
| Input field | `natal_charts.chartDetails` |
| Strata | aspect count (low/med/high), birth time known vs unknown |
| Production prompt | inline in [server/services/natalChartInsightService.ts:138](server/services/natalChartInsightService.ts#L138) (D), [:314](server/services/natalChartInsightService.ts#L314) (B) |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Natal Chart Reading ({{depth}})

A birth-chart interpretation covering nine fixed life areas. The reader is a non-expert who
wants to understand themselves; they are paying for insight that could only have been
written about their chart.

The nine categories are fixed and must all be present:
Personality & Identity · Career & Public Life · Finances & Material Possessions ·
Relationships & Partnerships · Health & Daily Routines · Home & Family Life ·
Education & Personal Growth · Social Life & Community · Spirituality & Inner World

Expected structure:
- detailed — each category has five sub-sections (key theme, strengths, challenges,
  actionable guidance, affirmation). The four prose sub-sections should each be a full
  paragraph of roughly 100–150 words; the affirmation is 1–2 sentences.
- brief — each category has the same five slots, each 1–2 short sentences.

## HOW TO READ THE INPUT DATA

INPUT DATA is the computed natal chart. The fields you will cite are:
- `planets` — each planet's sign, degree and house
- `houses` — house cusps and their signs
- `aspects` — aspects between planets, with type and orb
- `angles` — Ascendant, Midheaven and the other angles

Every astrological claim in the reading is checkable against these four fields and nothing
else. When you cite `inputRefs[].field`, name the field and the specific entry, e.g.
`planets.sun` or `aspects[saturn-mc]`.

## WHAT GROUNDED MEANS HERE

The reading is instructed to name chart factors in the text ("Your Sun in Taurus in the 2nd
House suggests..."). So grounding is directly checkable:

- A named placement (planet + sign, planet + house, angle + sign) must match `planets`,
  `houses` or `angles`. A placement that is not in the chart is a fabrication and fails the
  `input_grounding` hard gate — regardless of how well the surrounding prose reads.
- A named aspect must exist in `aspects`. Inventing an aspect is a fabrication.
- Interpretation built on a correctly-named placement is not checkable and must not be
  penalised under grounding — astrological meaning is a matter of tradition, not fact.
  Judge that under the supplementary metrics and under `usefulness`.
- Content that names no chart factors at all is not "safely ungrounded" — it is a
  `personalization` failure and, if the reading makes confident claims with no basis in the
  input, an `input_grounding` weakness.

If the chart has no birth time, houses and angles are unreliable. A reading that leans hard
on house placements in a timeless chart should be marked down under `input_grounding`; a
reading that acknowledges the limitation should not be penalised for hedging.

## SUPPLEMENTARY METRICS

aspect_coverage
  Does the reading engage with the significant aspects actually present in `aspects` —
  including the hard ones (squares, oppositions, difficult Saturn/Pluto contacts) — or does
  it cherry-pick only the flattering trines and sextiles? A model under cost pressure
  defaults to pleasantness. Score 5 when the major configurations present are addressed
  with their real character; score 2 or below when hard aspects present in the chart are
  simply absent from the reading. Cite the aspect you checked in `inputRefs`.

house_domain_accuracy
  Are placements mapped to the correct life area? A 2nd-house placement discussed under
  Finances & Material Possessions is correct; the same placement driving the Relationships &
  Partnerships section is a domain error. Generic reshuffling — where any placement appears
  to justify any category — is the failure mode. Score on correctness of the mapping, not on
  how much of it there is.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `aspect_coverage` | soft | |
| `house_domain_accuracy` | soft | |
