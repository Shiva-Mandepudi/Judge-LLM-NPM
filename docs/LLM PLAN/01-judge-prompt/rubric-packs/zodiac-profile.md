# Rubric Pack — Zodiac Profile

| | |
|---|---|
| Track key | `zodiac_profile` |
| Silver + challenger source | `user_zodiac_profiles.zodiacInsights` |
| Input | `birthDate` + `chartDetails` |
| Strata | sun sign (12) |
| Production prompt | `prompts/zodiac/Zodiac_Profile_Prompt_Final_1749681651129.md` |
| Notable | **bypasses the AI router** — hardcoded `gpt-4o` and its own OpenAI client at [server/auth/service.ts:1085](server/auth/service.ts#L1085). It cannot be swept across models until it is routed through `AI_FEATURE_KEYS`. Prerequisite, flagged in [03-build-plan/01](../../03-build-plan/01-build-phases.md). |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Zodiac Profile

A rich, shareable sun-sign identity profile. Four parts:
1. compact_view — sign name and symbol, element, modality, date range, planetary ruler,
   dominant traits, strengths, challenges, an archetype quote, and famous people.
2. detailed_view — identity archetype, elemental essence, modality expression, relationship
   style with compatibility, and further depth.
3. transformation_stages — named developmental stages, each with a symbol and description.
4. myth_symbolism — mythological grounding, including cultural variants.

This is the most shared artifact in the product, so public falsifiability matters: a wrong
ruling planet or a fabricated celebrity is something a reader's friends will catch.

## HOW TO READ THE INPUT DATA

INPUT DATA contains `birthDate` and `chartDetails`. The sun sign follows from `birthDate`.
Cite as `birthDate`, `chartDetails.planets.sun`.

## WHAT GROUNDED MEANS HERE

Unusually for this product, the core attributes of a sun sign are **fixed public facts**, not
interpretation. They are fully determined and exactly checkable:

  Aries — Fire, Cardinal, Mars        Taurus — Earth, Fixed, Venus
  Gemini — Air, Mutable, Mercury      Cancer — Water, Cardinal, Moon
  Leo — Fire, Fixed, Sun              Virgo — Earth, Mutable, Mercury
  Libra — Air, Cardinal, Venus        Scorpio — Water, Fixed, Mars/Pluto
  Sagittarius — Fire, Mutable, Jupiter  Capricorn — Earth, Cardinal, Saturn
  Aquarius — Air, Fixed, Saturn/Uranus  Pisces — Water, Mutable, Jupiter/Neptune

- The sign must be correct for `birthDate`.
- Element, modality, ruling planet and date range must be correct for that sign.
- Traits, archetypes, mythology and transformation stages are interpretation and are not
  checkable — judge them on coherence and quality, not factual truth.

## SUPPLEMENTARY METRICS

sign_attribute_accuracy — HARD GATE
  Is the sign correct for `birthDate`, and are its element, modality, ruling planet and date
  range correct? Fail the gate on any error and name it in `violation`. These are the most
  publicly falsifiable claims in the product.

famous_people_plausibility — HARD GATE
  Every named person in `compact_view.famous_people` must actually have this sun sign. This
  field is a hallucination magnet — a confident, specific, checkable, and completely
  fabricated claim is exactly what a model produces here. Fail the gate on any person whose
  known birthday falls outside this sign's date range, and name them in `violation`. If you
  do not know a named person's birthday, abstain with `input_insufficient` rather than
  guessing in either direction.

archetype_coherence
  Do the identity archetype, transformation stages and mythological framing describe one
  consistent character, and is that character recognisably this sign? Score 2 or below when
  the profile would fit a different sign with the name swapped.

cultural_care
  Are the cultural variants in `myth_symbolism` handled with specificity and respect, rather
  than flattened into stereotype or invented wholesale? Score on whether a reader from that
  culture would recognise the description as informed. Fabricated cultural tradition is both
  a quality failure here and a `safety_compliance` concern — note it in both.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `sign_attribute_accuracy` | **HARD** | fully determined public facts |
| `famous_people_plausibility` | **HARD** | explicit hallucination trap; abstention permitted |
| `archetype_coherence` | soft | |
| `cultural_care` | soft | cross-reports into `safety_compliance` |
