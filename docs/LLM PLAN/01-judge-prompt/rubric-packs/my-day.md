# Rubric Pack — My Day Daily Bundle

| | |
|---|---|
| Track key | `my_day` |
| Silver + challenger source | `user_dynamic_profiles` (~35 flattened columns) |
| Input | natal chart + **freshly computed transit chart for the target date** + 7 numerology numbers + `targetDate` |
| Strata | day-of-week, moon phase, season |
| Production prompt | `prompts/astrology/Astrology_Dynamic_Elements_Prompt_1749103245949.md` — **the filename is `MY_DAY_PROMPT_VERSION`** and is persisted in `user_dynamic_profiles.prompt_version` |
| Notable | largest single output in the product: 5 sections, ~100 fields, one call. Has a full Zod contract, a markup sanitiser, and a 2-attempt self-repair loop in production ([my-day-generation-contract.ts](server/services/my-day-generation-contract.ts)) |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — My Day Daily Bundle

One generation covering a reader's whole day, consumed as five separate cards in the app.
This is the highest-frequency content in the product — a reader may see it every morning —
so genericness is punished harder here than anywhere else.

Five sections, all required:
1. Cosmic Forecast — daily horoscope across seven life facets, plus planetary transits
   summary, planetary ruler of the day, moon sign, moon phase, moon void status, lunar
   return flag, cosmic energy score, elemental energy.
2. Daily Vibe Check — mind/body/spirit scores, mental clarity, emotional forecast, chakra
   tip, astro wellness tip, healing suggestion.
3. Your Lucky Vibes Today — lucky colour, crystal, flower, herb, food, gemstone, luck
   score, numerology day vibe.
4. What Should You Do Today? — action focus, **exactly six activity suggestions**, daily
   affirmation, power time, reflection prompt.
5. Relationship & Social Vibes — social connection score, relationship vibe, compatibility
   vibe.

## HOW TO READ THE INPUT DATA

INPUT DATA contains:
- `targetDate` — the day this bundle is for
- `natalChart` — the reader's birth chart (`planets`, `houses`, `aspects`, `angles`)
- `transitChart` — the transit chart computed for `targetDate`
- `numerology` — lifePath, expression, soulUrge, personality, birthday, currentPersonalYear,
  and the day's numerology value

Cite as `targetDate`, `transitChart.planets.<body>`, `natalChart.planets.<body>`,
`numerology.<field>`.

## WHAT GROUNDED MEANS HERE

- Astronomical claims are checkable and must match `transitChart`: moon sign, moon phase,
  planetary ruler of the day, void-of-course status, lunar return. A stated moon phase that
  contradicts the transit chart is a factual error, not a stylistic choice — this is the
  most concrete grounding check on this track.
- Named transits must exist in `transitChart`; named natal placements in `natalChart`.
- Numerology references must match `numerology`.
- Lucky colour / crystal / flower / herb / food / gemstone are not checkable against the
  input — they are the model's assignment. Do not score them under grounding. Score them
  under `usefulness` and `internal_consistency` (e.g. a lucky colour that contradicts the
  elemental energy claimed elsewhere in the same bundle).
- The numeric scores are the model's own and are not checkable for truth, only for
  coherence with the narrative that accompanies them.

## SUPPLEMENTARY METRICS

date_correctness — HARD GATE
  Does the bundle refer to `targetDate` and only to `targetDate`? Any day-of-week, date, or
  "today/tomorrow" language that contradicts `targetDate` fails the gate. This catches a
  specific and serious defect class: content generated on one path or schedule being served
  for the wrong day. Cite `targetDate` and quote the offending span.

astronomical_accuracy — HARD GATE
  Do moon sign, moon phase, void status, lunar return and planetary ruler match
  `transitChart`? Fail the gate on a contradiction. These are stated as facts to the reader
  and are trivially falsifiable by anyone who checks, so an error here is a credibility
  failure, not a quality nuance. If the input does not contain the relevant field, abstain
  with `input_insufficient` rather than guessing.

cross_section_coherence
  The five sections are generated in one call but consumed as five separate cards. Do they
  agree with each other and describe one coherent day? A high cosmic energy score beside a
  depleted emotional forecast, or an "avoid social contact" wellness tip beside a
  "reach out to friends" relationship vibe, is incoherent. Score 5 when the day has one
  consistent character across all five; score 2 or below on direct contradictions.
  Cite both sides of the contradiction in `quote`.

transit_timing_relevance
  Does the content reflect the actual transits on `targetDate`, or is it evergreen daily
  uplift that would fit any date? This is the metric most likely to expose a genuine quality
  gap in a cheaper model, because date-independent positivity is much easier to produce than
  a real transit reading.

activity_validity
  The six activity suggestions have a structural contract: exactly six; each with a wellness
  domain from {Physical, Mental, Financial, Nutritional, Social, Spiritual}; an activity type
  from {timed, logging, action}; a duration; instructions; and the type-dependent fields —
  `log_prompt` for logging activities, `action_instruction` for action activities. Check:
  count is six, domains are meaningfully varied rather than six of the same, durations are
  plausible for the activity described, the type matches the fields present, and each
  activity is something a person could actually do today. Score 2 or below on a
  missing/duplicated activity or a domain-type mismatch.

numerology_day_integration
  Is the numerology day vibe consistent with `numerology` and with the rest of the bundle,
  or a detached paragraph? Score on whether the numbers actually inform the day's character.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `date_correctness` | **HARD** | catches wrong-day serving |
| `astronomical_accuracy` | **HARD** | falsifiable public facts |
| `cross_section_coherence` | soft | the defining risk of a single-call, five-card product |
| `transit_timing_relevance` | soft | highest-signal quality metric |
| `activity_validity` | soft | structural + practical |
| `numerology_day_integration` | soft | |
