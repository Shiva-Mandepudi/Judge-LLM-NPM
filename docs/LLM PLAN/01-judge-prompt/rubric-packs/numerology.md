# Rubric Pack — Numerology Single-Number Reading

| | |
|---|---|
| Track keys | `numerology_brief`, `numerology_detailed` |
| Silver + challenger source | `numerology_readings.briefInsight` / `.detailedInsight`, keyed by `profileId` → `numerologyProfiles.userId` |
| Input | **one integer** (+ `year` for `personal_year`) |
| Strata | `numberType` × 6 → **6 rows per user per depth** |
| Production prompt | file-backed, 12 files in `prompts/numerology/`; **the filename is the prompt version** |
| Notable | the only track with a strict schema, a Zod validator, a safety regex and throw-on-invalid in production ([numerology-generation-request-builder.ts:243](server/services/numerology-generation-request-builder.ts#L243)) |

The six number types: `life_path`, `expression`, `soul_urge`, `personality`,
`birthday_number`, `personal_year`.

**Finite input space.** Canonical values are `[1–9, 11, 22, 33]` for five types and
`[1–9, 11, 22]` for `birthday_number` — **71 values**, × 2 depths = **142 distinct pieces of
content**. This is the only track whose entire input domain can be enumerated, and its
content is cached and served to every future user with that number. Sampling is the wrong
tool; see [03-build-plan/02](../../03-build-plan/02-statistical-design.md#5-numerology-is-exhaustive-not-sampled).

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Numerology {{number_type_label}} Reading ({{depth}})

An interpretation of one specific numerology number. The entire input is that number. The
reader wants to understand what their number means for them.

Expected structure: four to five named sections depending on number type. For
`personal_year` specifically, a month-by-month forecast section is required.

Expected length:
- detailed — each section a full paragraph, roughly 100–150 words.
- brief — one sentence of roughly 20–30 words per field.

## HOW TO READ THE INPUT DATA

INPUT DATA contains only:
- `numberType` — which of the six numbers this is
- `numberValue` — the integer
- `year` — present only for `personal_year`

That is the whole factual basis. Cite `inputRefs[].field` as `numberValue`, `numberType` or `year`.

## WHAT GROUNDED MEANS HERE

Because the input is a single integer, grounding is unusually sharp:

- The reading must be about `numberValue`. A reading given 7 that interprets 5 fails
  `input_grounding` outright.
- The reading must be about `numberType`. A reading asked for a Soul Urge that discusses
  "your Life Path" has answered a different question using a number it was never given —
  this is fabrication, not a style issue, and fails `input_grounding`. This is a real and
  easily-missed failure mode: the model has one number and may attach it to the wrong
  concept, or invent sibling numbers it was not provided.
- No other numbers may be introduced. The input contains exactly one; a reading that
  references the reader's expression number, birth date or chart has invented data.
- For `personal_year`, the reading must anchor to `year` — see `year_anchoring`.

## SUPPLEMENTARY METRICS

canonical_meaning_fidelity — HARD GATE
  Does the interpretation match the established numerological meaning of this number? The
  canonical characters are well documented and stable: 1 initiative and independence,
  2 partnership and diplomacy, 3 expression and creativity, 4 structure and discipline,
  5 freedom and change, 6 responsibility and nurture, 7 analysis and inner search,
  8 material mastery and authority, 9 completion and humanitarian service, 11 intuitive
  illumination, 22 the master builder, 33 the master teacher.
  Score 5 when the reading is recognisably that number throughout. Fail the gate when the
  core character is wrong — e.g. a 4 written as free-spirited and change-seeking. Interpretive
  latitude within the correct character is fine and must not be penalised; contradiction of
  the character is not.
  This gate matters more here than anywhere else in the product: this content is generated
  once and served to every future reader with that number, so an error does not average out.

master_number_handling — HARD GATE
  When `numberValue` is 11, 22 or 33, is it treated as a master number with its own
  character, and not as 2, 4 or 6? A master number reading that is indistinguishable from
  its reduced digit fails the gate. Mentioning the reduced digit as an undertone is correct
  practice and is not a failure; collapsing entirely into it is. When `numberValue` is not a
  master number, abstain with `metric_not_applicable`.

number_type_discipline
  Is the reading unambiguously about `numberType`, using that number's own frame? A Soul
  Urge reading should read as inner desire and motivation; a Personality reading as outward
  impression; a Birthday reading as a specific gift. Score 2 or below when the sections
  would fit any number type equally — a generic template with the number substituted in.

year_anchoring
  For `personal_year` only: does the reading explicitly anchor to `year`, and is the
  month-by-month forecast present and specific to that year's cycle? Fail low when the year
  is never named, since the content is year-scoped and gets regenerated annually. For every
  other number type, abstain with `metric_not_applicable`.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `canonical_meaning_fidelity` | **HARD** | the highest-stakes metric in the whole suite — permanent cached content |
| `master_number_handling` | **HARD** | conditional on `numberValue ∈ {11,22,33}` |
| `number_type_discipline` | soft | |
| `year_anchoring` | soft | conditional on `numberType = personal_year` |
