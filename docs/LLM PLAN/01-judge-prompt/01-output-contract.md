# Judge Output Contract

One judge call scores one row. The response is **structured output**, not free text —
scores must be machine-aggregable at 2,700 × (k+1) rows without a parser that can drift.

## Enforcement

Use the provider's native constrained-decoding path, with the schema generated from the
composed rubric so the required metric keys for *that track* are exactly the keys the judge
must return:

- **Anthropic** — `output_config: { format: { type: "json_schema", schema } }` on
  `messages.create`. Pair with `thinking: { type: "adaptive" }` so reasoning genuinely
  precedes scoring rather than being simulated by prompt instruction.
- **OpenAI** — `response_format: { type: "json_schema", json_schema: { strict: true, schema } }`.
- **Gemini** — `responseMimeType: "application/json"` **plus** `responseSchema`. Note that
  CG's own production path passes only the mime type
  ([server/services/unified-ai-service.ts:266](server/services/unified-ai-service.ts#L266)) —
  do not repeat that here.

The schema is **generated per track**, never hand-maintained: `requiredMetrics` comes from
the track's rubric pack, so a rubric change cannot silently desynchronise from the schema.

## Schema

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["rowId", "metrics", "overall"],
  "properties": {
    "rowId": { "type": "string" },

    "metrics": {
      "type": "object",
      "additionalProperties": false,
      // keys generated from the track's composed rubric:
      //   universal (8) + reading-specific (n) + comparative (4, when silver present)
      "properties": {
        "<metricKey>": {
          "type": "object",
          "additionalProperties": false,
          "required": ["score", "abstainReason", "evidence"],
          "properties": {
            "score":         { "type": ["integer", "null"], "minimum": 1, "maximum": 5 },
            "abstainReason": { "type": ["string", "null"],
                               "enum": ["no_evidence_in_output", "input_insufficient",
                                        "metric_not_applicable", "output_unintelligible", null] },

            "evidence": {
              "type": "object",
              "additionalProperties": false,
              "required": ["candidateQuotes", "referenceQuotes", "inputRefs", "absences", "rationale"],
              "properties": {

                "candidateQuotes": {
                  "type": "array", "maxItems": 4,
                  "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["quote"],
                    "properties": {
                      "quote":   { "type": "string", "maxLength": 300 },
                      "section": { "type": ["string", "null"] }
                    }
                  }
                },

                "referenceQuotes": {
                  "type": "array", "maxItems": 4,
                  "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["quote"],
                    "properties": {
                      "quote":   { "type": "string", "maxLength": 300 },
                      "section": { "type": ["string", "null"] }
                    }
                  }
                },

                "inputRefs": {
                  "type": "array", "maxItems": 6,
                  "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["field"],
                    "properties": {
                      "field": { "type": "string", "maxLength": 120 },
                      "value": { "type": ["string", "null"], "maxLength": 200 },
                      "note":  { "type": ["string", "null"], "maxLength": 200 }
                    }
                  }
                },

                "absences": {
                  "type": "array", "maxItems": 6,
                  "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["expected", "scope", "note"],
                    "properties": {
                      "expected": { "type": "string", "maxLength": 200 },
                      "scope":    { "type": "string",
                                    "enum": ["section_missing", "required_field_empty",
                                             "input_fact_unaddressed", "expected_element_absent"] },
                      "note":     { "type": "string", "maxLength": 300 }
                    }
                  }
                },

                "rationale": { "type": ["string", "null"], "maxLength": 500 }
              }
            },

            // present only for metrics the rubric marks HARD GATE
            "gate":      { "type": ["string", "null"], "enum": ["pass", "fail", null] },
            "violation": { "type": ["string", "null"], "maxLength": 400 }
          }
        }
      }
    },

    "overall": {
      "type": "object",
      "additionalProperties": false,
      "required": ["summary", "confidence", "confidenceReason"],
      "properties": {
        "summary":          { "type": "string", "maxLength": 600 },
        "confidence":       { "type": "string", "enum": ["low", "medium", "high"] },
        "confidenceReason": { "type": "string", "maxLength": 300 },
        "silverComparison": {
          "type": ["string", "null"],
          "enum": ["equivalent", "candidate_richer", "silver_richer",
                   "substantive_disagreement", "candidate_degenerate", null]
        }
      }
    }
  }
}
```

`overall.summary` is diagnostic only. It is never aggregated into any statistic — it exists
so a human reading the audit slice can see the judge's reasoning at a glance.

## Post-parse validation — reject, never repair

A schema-valid response can still be internally incoherent. These are enforced in code, and
a violation makes the judge response **invalid** (recorded, then retried once with a
corrective note; a second failure is recorded as `judgeStatus: "invalid"` and the row is
excluded from that metric's statistics with the exclusion rate disclosed).

| Rule | Rationale |
|---|---|
| Exactly one of `score` / `abstainReason` is non-null | a score *and* an abstention is nonsense |
| `score` non-null ⇒ **at least one** of `candidateQuotes`, `absences`, or (COMPARATIVE only) `referenceQuotes` is non-empty | **the evidence requirement**, mechanically enforced. `inputRefs` + `rationale` alone are not evidence |
| every `candidateQuotes[].quote` is a **verbatim substring** of the rendered candidate output (whitespace-normalised) | catches paraphrased or fabricated quotes — the highest-value check here |
| every `referenceQuotes[].quote` is a **verbatim substring** of the rendered silver reference | same, for the reference side |
| `referenceQuotes` non-empty ⇒ the metric is marked COMPARATIVE **and** `includeSilverReference` was true for this row | stops the reference being used to justify an absolute score |
| `absences[].scope = section_missing` or `required_field_empty` ⇒ the named `expected` section/field is genuinely absent or empty in the rendered candidate | **exactly checkable** against the track's declared section list |
| `absences[].scope = input_fact_unaddressed` ⇒ at least one `inputRefs` entry is present | an absence claim must rest on a fact that exists in the input, not on the judge's expectation |
| grounding-class metric with `score` non-null ⇒ `inputRefs` non-empty | grounding claims must name what they were checked against |
| every `inputRefs[].field` resolves to a field present in the rendered input | catches invented field references |
| `inputRefs[].value`, where given, matches the value at that field | catches misreading of the input — a check the single-`inputRef` design could not make |
| `candidateQuotes` and `referenceQuotes` each ≤ 4; `inputRefs` and `absences` each ≤ 6 | bounds judge output cost |
| HARD GATE metric: `score` non-null ⇒ `gate` non-null; `gate: "fail"` ⇒ `violation` non-null | a gate verdict cannot be omitted or unexplained |
| `gate: "fail"` ⇒ evidence contains a `candidateQuote` **or** an `absence` | a gate failure must point at something concrete, present or missing |
| `abstainReason` non-null ⇒ `gate` is null and all evidence arrays are empty | no evidence for a score that was not given |
| `metrics` keys exactly equal the track's composed rubric key set | no extra, no missing |

The verbatim-substring checks are the backbone of the evidence requirement. Without them,
"cite evidence" degrades into "write something quote-shaped".

**Absence claims are only partly verifiable, and the contract is explicit about which part.**
`section_missing` and `required_field_empty` are exact — the track declares its section list,
so their presence or emptiness is a lookup. `input_fact_unaddressed` and
`expected_element_absent` are semantic: the harness can verify that the cited input fact
*exists* (so the expectation is legitimate) and that the `expected` term does not appear
verbatim in the candidate, but it cannot prove the fact is unaddressed under some paraphrase.
Those two scopes are therefore **flagged for the evidence audit** rather than trusted, and
their rate per (track, model) is reported — see
[03-build-plan/04](../03-build-plan/04-reporting-and-human-review.md#audit-4--evidence).

## Abstention semantics downstream

Abstentions are **never imputed** — not to the mean, not to the midpoint, not to zero.

| Consumer | Handling |
|---|---|
| Per-metric mean | computed over scored rows only; **abstention rate reported alongside every mean** |
| Composite quality | a row is included only if all universal soft metrics are scored; otherwise the row is `partial` and counted separately |
| Hard-gate failure rate | denominator is rows with a non-null gate; abstention rate reported separately |
| Model comparison | if two models differ materially in abstention rate on a metric, that difference **is a finding** — usually one model's output is too vague to assess — and is reported, not averaged away |

A high abstention rate is diagnostic signal about the *candidate*, about the *rubric*, or
about the *renderer*. Conflating it with a low score destroys that signal.

## Judge call record

Every call persists, for cost, reproducibility and audit:

```jsonc
{
  "rowId": "...", "runId": "...",
  "track": "...", "userId": "...", "stratum": {...},
  "modelRef": "arm-3",              // opaque; resolved to a model only at aggregation
  "judgeModel": "...", "judgeEffort": "...",
  "kernelHash": "sha256:...", "rubricPackHash": "sha256:...", "schemaHash": "sha256:...",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadInputTokens": 0,
             "cacheCreationInputTokens": 0 },
  "latencyMs": 0, "costUsd": 0.0,
  "judgeStatus": "ok | invalid | error",
  "attempt": 1,
  "response": { ... }
}
```

`kernelHash` / `rubricPackHash` / `schemaHash` make a run reproducible and make prompt drift
visible: scores produced under different hashes are **not comparable** and the report must
refuse to pool them.

`modelRef` is opaque throughout scoring. The mapping `modelRef → model` is held outside the
judged artifact and joined only at aggregation — that is the blinding mechanism, and a test
asserts no model string appears in any judge payload.
