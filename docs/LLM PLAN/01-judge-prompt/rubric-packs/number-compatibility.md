# Rubric Pack — Number Compatibility

| | |
|---|---|
| Track keys | `number_compatibility_brief`, `number_compatibility_detailed` |
| Silver + challenger source | `compatibility_readings` where `readingType='number_compatibility'` |
| Input | both people's six numerology numbers |
| Strata | master number present in either person, yes/no |
| Production prompt | **file-backed**: `prompts/numerology/NumberCompatibility_{Brief,Detailed}_Prompt.md` |

## `RUBRIC_PACK` (verbatim)

```text
## READING TYPE — Number Compatibility Reading ({{depth}})

Numerological compatibility between two people, derived entirely from their numbers, with a
score per dimension and an overall score.

Six sections:
Life Path Compatibility · Expression Number Compatibility · Soul Urge Compatibility ·
Personality Number Compatibility · Challenges & Growth Potential ·
Overall Compatibility (carrying the overall score)

Each section has three prose fields and a Score.

## HOW TO READ THE INPUT DATA

INPUT DATA is two sets of numbers only — no chart, no birth data:
- `person1.name`, `person1.lifePathNumber`, `.expressionNumber`, `.soulUrgeNumber`,
  `.personalityNumber`, `.birthdayNumber`, `.currentPersonalYear`
- the same six fields for `person2`

Cite as `person1.lifePathNumber` etc. There is nothing else to check against.

## WHAT GROUNDED MEANS HERE

The input is small and fully enumerable, which makes grounding unusually strict here:

- Every number the reading names must match the input exactly. Stating a life path of 7 when
  the input says 5 is a fabrication and fails `input_grounding`.
- The reading must use *both* people's numbers. Interpreting only one person's numbers is a
  failure of the product, scored under `number_pair_fidelity`.
- The reading must not introduce numbers it was not given, and must not silently reduce a
  master number (11, 22, 33) to its single digit.
- Interpretive meaning attached to a correctly-stated number is judged under
  `canonical_meaning_fidelity`, not under grounding.

## SUPPLEMENTARY METRICS

canonical_meaning_fidelity — HARD GATE
  Does each number's interpretation match its established numerological meaning? Life Path 8
  is material mastery, authority, ambition — not spiritual retreat. Score 5 when every
  meaning is recognisably correct; fail the gate when a number is given a meaning that
  contradicts its canonical character, since a reader who checks anywhere else will see the
  contradiction. Cite the number in `inputRefs`.

master_number_handling — HARD GATE
  Where 11, 22 or 33 appear in the input, are they treated as master numbers with their own
  distinct character, rather than as 2, 4 or 6? This is the most common numerology error and
  the easiest to miss. Fail the gate when a master number in the input is interpreted as its
  reduced digit. If no master number is present, abstain with `metric_not_applicable`.

number_pair_fidelity
  Is each section genuinely about the interaction between the two relevant numbers, or does
  it describe one number and mention the other? Score 5 when the pairing drives the
  interpretation in every section.

score_narrative_coherence
  Does each section's Score match its prose, and is `Overall Compatibility` consistent with
  the section scores? Cite the mismatch.
```

## Supplementary metric keys

| Key | Gate | Notes |
|---|---|---|
| `canonical_meaning_fidelity` | **HARD** | |
| `master_number_handling` | **HARD** | conditional — abstains when no master number present |
| `number_pair_fidelity` | soft | |
| `score_narrative_coherence` | soft | |

> The production TypeScript interfaces name the final section `"Final Insight"` while the
> prompt files emit `"Overall Compatibility"`; the app tolerates both
> ([numerologyCompatibilityService.ts:187](server/services/numerologyCompatibilityService.ts#L187)).
> The renderer must normalise to one name before prompting, or `structural_completeness`
> will fire on a naming artifact rather than a real defect.
