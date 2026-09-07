# Rubric Pack — Transit Reading

| | |
|---|---|
| Track keys | `transit_brief`, `transit_detailed` |
| Silver + challenger source | `transit_readings.briefInsight` / `.detailedInsight` |
| Input fields | `transit_readings.chartDetails`, `transit_readings.transitDate` |
| Strata | aspect count, season |
| Production prompt | inline in [server/services/transitInsightService.ts:405](server/services/transitInsightService.ts#L405) |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Transit Reading ({{depth}})

What a specific date's planetary transits mean for this person, across nine life areas. The
reader wants to know what is happening to them *now*, and when.

The nine categories are fixed:
Timing & Key Events · Career & Vocation · Finances & Resources · Love & Relationships ·
Personal Growth & Inner Work · Health & Well-Being · Home & Family Life ·
Social Life & Community · Spirituality & Life Purpose

Expected structure:
- detailed — five sub-sections per category (key theme, opportunities, challenges,
  guidance, affirmation), the four prose ones roughly 100–150 words each.
- brief — the same five slots, one short sentence each.

## HOW TO READ THE INPUT DATA

INPUT DATA contains the transit chart and the date it was computed for:
- `transitDate` — the date this reading is about
- `planets` — transiting planet positions (sign, degree, house)
- `aspects` — transit-to-natal contacts, with type and orb
- `houses`, `angles` — as in a natal chart

Cite `inputRefs[].field` as `transitDate`, `planets.<body>`, or `aspects[<transit>-<natal>]`.

## WHAT GROUNDED MEANS HERE

Same fabrication rule as any chart reading: a named transit or aspect must exist in the
input. Two additional failure modes are specific to transits and are the point of this track:

- **Evergreen filler.** Content that would be equally true on any date of any year is not
  a transit reading. "Today is a good day to focus on yourself" grounded in nothing is the
  canonical failure. This is the single most likely place a cheaper model degrades, because
  producing date-independent uplift is easier than reading an ephemeris.
- **Natal restatement.** A transit reading that describes fixed personality traits has
  answered the wrong question. Transits are temporary overlays on the natal chart; the
  reading must be about the moving parts.

Timing language ("mid-month", "over the next three weeks") is checkable against the transit
orbs in `aspects` — a claimed window that contradicts the orb data is a grounding failure.
Vague timing is a `timing_specificity` weakness, not a grounding failure.

## SUPPLEMENTARY METRICS

transit_timing_relevance
  Does the content plausibly reflect the transits actually present on `transitDate`? Score 5
  when specific transits are named and their meaning is developed; score 3 when transits are
  named but the interpretation would fit any transit; score 1 when the reading is
  date-independent uplift with no transit content at all. Cite the transit you checked.

transit_natal_distinction
  Does the reading treat transits as a temporary condition acting on the person, rather than
  restating who they are? Score 5 when the temporal framing is consistent and explicit;
  score 2 or below when whole sections read as natal personality description.

timing_specificity
  Where the reading implies timing, is it specific enough to act on and consistent with the
  orb data? Vague-but-honest beats confident-but-invented. Do not reward doom dates or
  false precision.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `transit_timing_relevance` | soft | the highest-signal metric on this track |
| `transit_natal_distinction` | soft | |
| `timing_specificity` | soft | |
