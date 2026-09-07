# Silver Similarity Metrics

The comparative axis: challenger versus silver reference, on the same input.

> **similarity ≠ truth.** The silver reference is frontier-model-generated and
> human-reviewed. It is a high-quality second opinion, not an answer key. These metrics are
> **reported as their own axis** in the final decision. They are never summed into
> `composite_quality`, and high similarity is never the objective.

Getting this wrong is the classic failure of reference-based evaluation: score similarity as
quality and you have built a machine that selects for *imitating the reference* and penalises
any challenger that genuinely exceeds it. The metrics below are shaped to make "better than
silver" a visible, positive outcome.

## Why not embedding or n-gram similarity

Not used, at any point. For interpretive prose there is no correct wording:

| Approach | Why rejected |
|---|---|
| BLEU / ROUGE / n-gram overlap | rewards paraphrase, punishes legitimate rewording; near-zero correlation with reading quality |
| Embedding cosine | measures topical proximity; a fluent, generic, wrong reading sits close to a specific, correct one |
| Exact-field diff | every field here is free prose; a diff is 100% noise |

All similarity here is **judged, semantic, and evidence-cited** — the same evidence
requirement as every other metric, with one addition: these are the only metrics permitted to
populate `referenceQuotes`, so a comparative finding cites **both** sides. A
`substantive_disagreement` must show the candidate's claim and the reference's claim as
separate verbatim spans, plus the input fact they disagree about in `inputRefs`. That triple
is what makes the disagreement reviewable by a human rather than a bare verdict.

## The four comparative metrics

Appended to the system prompt only when `prompt.includeSilverReference: true`, and marked
`COMPARATIVE` in the rubric list so the kernel's silver-handling rules apply.

### `COMPARATIVE_METRIC_BLOCK` (verbatim)

```text
## COMPARATIVE METRICS — challenger against the SILVER REFERENCE

Before scoring these, re-read the kernel's rules on the silver reference. It is a
high-quality reference, not a target and not ground truth. Resemblance is not a virtue and
divergence is not a defect. Where the two disagree about a fact, the INPUT DATA decides.

coverage_parity
  Does the READING UNDER REVIEW address the same substantive ground as the silver reference —
  the same input features, the same life areas, the same significant themes? Judge coverage
  of substance, never of wording, structure or ordering.
  Score 5 when everything materially covered by the reference is also addressed, in whatever
  form. Score 5 also when the reading covers additional substantive ground the reference
  omits — breadth beyond the reference is not a deduction. Score 3 when a theme the reference
  develops is touched only in passing. Score 1 when significant ground the reference covers
  is simply absent.
  Cite the specific theme you checked. Where the reference develops a theme the candidate
  omits, that is an `absence` (scope `expected_element_absent`) paired with the
  `referenceQuote` that establishes the theme.

interpretive_agreement
  Where both readings make an interpretive claim about the same input feature, do they
  substantively agree?
  Score 5 for agreement on every shared claim, or where differences are matters of emphasis
  rather than substance. Score 3 for a noticeable divergence in emphasis that a reader would
  register. Score 1 for direct substantive contradiction — the same placement, number or card
  read to mean opposite things.
  A low score here is a FLAG, not a verdict. When you score 3 or below, say in the rationale
  which reading the INPUT DATA supports, or state that the input does not settle it. Do not
  assume the reference is correct.

depth_parity
  Is the analytical depth comparable? Does the reading develop its claims — connecting input
  to meaning to consequence — to a similar degree?
  Score 5 for comparable or greater depth. Score 3 where the reading is noticeably thinner:
  it asserts where the reference explains. Score 1 for a reading that is substantially
  shallower — surface labels where the reference reasons.
  Depth is not length. A concise reading that develops its claims has depth. A long one that
  restates does not. Never infer depth from word count.

reference_advantage
  Taking both readings as a whole, and judging only against the INPUT DATA and this reading
  type's purpose: which better serves the reader?
  Score 5 — the reading under review is clearly better than the reference.
  Score 4 — slightly better.
  Score 3 — genuinely equivalent.
  Score 2 — slightly worse.
  Score 1 — clearly worse.
  This is the one metric permitted to prefer either side, and 5 must be reachable and is
  expected sometimes. Do not default to 3. If you cannot separate them on the evidence,
  3 is correct — but say so explicitly in the rationale.
```

Also emitted, in `overall.silverComparison`, a categorical verdict that no scalar captures:

| Value | Meaning |
|---|---|
| `equivalent` | genuinely interchangeable in quality |
| `candidate_richer` | the challenger adds real, grounded substance the reference lacks |
| `silver_richer` | the reference has substance the challenger lacks |
| `substantive_disagreement` | they contradict each other on a claim about the input — **always triage into the human audit slice** |
| `candidate_degenerate` | the challenger has collapsed — generic, truncated, repetitive, or off-task |

`substantive_disagreement` and `candidate_degenerate` are the two rates that matter most on
this axis. A challenger with a high `candidate_degenerate` rate is disqualified on quality
regardless of its mean scores. A high `substantive_disagreement` rate is ambiguous by
construction — it means the challenger and a human-reviewed reference read the same input
differently — and is exactly what the human audit slice exists to resolve.

## How similarity enters the decision

As a **guardrail and a diagnostic**, never as a maximand:

| Signal | Role in the decision |
|---|---|
| `candidate_degenerate` rate | **eliminator** — above the configured tolerance, the model is out for that track |
| `reference_advantage` mean + CI | reported beside `composite_quality` as a second, independent read on quality |
| `substantive_disagreement` rate | **routes rows into the human audit slice**; does not itself score |
| `coverage_parity`, `depth_parity`, `interpretive_agreement` | diagnostics — they explain *why* a model ranks where it does |

There is deliberately **no "minimum similarity" threshold**. A challenger that diverges from
silver while scoring well on the universal metrics and passing every gate is a *good*
outcome, not a suspicious one.

## Two validity checks this axis requires

Neither is optional — without them the similarity numbers cannot be trusted.

### 1. Reference-contamination check

Showing the judge a human-reviewed reference may anchor it, inflating or depressing the
*universal* metrics — which are supposed to be absolute and reference-independent.

**Check:** on a ~10% subsample, run the identical rows twice — once with
`includeSilverReference: true`, once `false`. Compare the universal metric scores.

- Scores materially unchanged → no contamination; universal metrics are safe to pool.
- Scores shift systematically → the judge is anchoring on the reference. Then the universal
  metrics must be produced in a **reference-free pass**, and the comparative metrics in a
  separate pass. That doubles judge cost on those metrics, which is why the check runs early
  in [Phase 3](../03-build-plan/01-build-phases.md#phase-3--judge-calibration) rather than
  after a full sweep.

### 2. Score the silver reference as a blind arm

Silver is itself model-generated. Enter it into the judged pool as an unlabelled arm, with a
`modelRef` indistinguishable from the challengers.

This is cheap and it buys four things:

1. **A quality benchmark** on the same scale as every challenger — how good is the reference, actually.
2. **Evidence that human review worked.** If silver does not outscore an un-reviewed
   frontier-model arm, the review stage is not adding what it is assumed to add.
3. **A judge-bias probe.** If the judge shares a model family with the silver generator, it
   will favour silver. A silver arm that outscores every challenger on every track by a
   suspiciously uniform margin is the signature. This is why the judge model must come from
   a different vendor family than both the silver generator and the champion.
4. **A calibration anchor** — a fixed point across runs, so score drift between runs can be
   distinguished from genuine model differences.

When silver runs as a blind arm, its own rows are scored with `includeSilverReference: false`
(it cannot be compared against itself), so silver has universal metrics and gates but no
comparative metrics. The report must state this asymmetry wherever silver appears in a table.
