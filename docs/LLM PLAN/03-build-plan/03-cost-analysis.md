# Cost Analysis

Cost is a first-class decision input, not a footnote. Three questions must be answerable:
what does one reading cost, what does one **user** cost, and what does the **evaluation
itself** cost.

## 1. Per-reading cost

Sourced from the challenger generation records, not re-derived:

```
cost(row) = inputTokens  / 1e6 × rates[model].input
          + outputTokens / 1e6 × rates[model].output
```

Reported per `(track, model)`: **median and p95** cost, median and p95 latency, and median
input/output tokens. Median rather than mean — output length is right-skewed and a mean is
dragged by the tail.

**Unknown rate ⇒ `unknown`, never zero.** A missing rate must propagate as `unknown` and
block the cost comparison for that model, per
[02-statistical-design.md](02-statistical-design.md#9-what-the-report-must-refuse-to-do).

### Output-token envelope per track

From the production `maxOutputTokens` in CG — these are ceilings, not actuals, but they set
the shape of the cost distribution and explain why per-track costs differ by an order of
magnitude:

| Track | Brief | Detailed |
|---|---|---|
| `natal_*` | 6,000 | **16,000** |
| `transit_*` | 6,000 | **16,000** |
| `synastry_*` | 6,000 | **16,000** |
| `composite_*` | 6,000 | **16,000** |
| `number_compatibility_*` | 2,000 | 3,500 |
| `numerology_*` | 2,000 | 2,000 |
| `tarot_*` | 2,000 | 3,000 |
| `my_day` | — | 4,000 |
| `static_scores` | — | 4,000 (temperature 0.3) |
| `zodiac_profile` | — | 6,000 |

**Ceiling per user across all 27 rows: ~136,500 output tokens.** The four detailed chart
tracks alone account for 64,000 of that — **47% of a user's output-token budget sits in four
of twenty-seven readings.** Those four are where a model change moves the bill, and they are
also the four whose quality is hardest to assess. That tension is the central finding this
system exists to resolve.

## 2. Per-user rollup

The business number. For each `(user, model-config)`:

```
cost_per_user(config) = Σ cost(row) over that user's 27 rows
```

Reported as a distribution — median, p95, and a cluster-bootstrap CI on the median — not a
single figure. The p95 matters operationally: a heavy-chart user costs materially more than a
median one, and capacity planning runs on the tail.

Two configurations are always rolled up:

| Config | Definition |
|---|---|
| `champion_uniform` | the champion model on all 17 tracks — today's cost |
| `per_track_optimal` | the winner of the [decision rule](02-statistical-design.md#6-decision-support--what-the-engine-computes-who-decides) on each track |

`Δ cost_per_user` between them, with a CI, is the headline deliverable of the whole exercise.

## 3. Consolidated

```
monthly = Σ_track  volume[track] × cost_per_reading[track, chosen_model]
```

`volume[track]` is config. Sources available in CG today:

- `ai_usage_metrics` — daily per-user token and count rollups with a `readingTypeBreakdown`
  (written only by the legacy `aiService.ts` path, so partial).
- Row counts on the reading tables, differenced over a period — coarser but complete.

**Where a track's volume is unknown, report cost-per-reading only and mark the consolidated
total as partial.** An unweighted sum across tracks whose real volumes differ by orders of
magnitude — `my_day` is generated daily per active user; `composite` is a paid one-off at 120
credits — is not an estimate, it is a fabrication.

Report three lines: today's cost, the per-track-optimal cost, and the delta — each with the
volume assumptions printed beside it.

## 4. The judge's own cost

Not free, and it belongs in the report.

Judge input per call is dominated by the content under review, not by the prompt:

```
judge_input ≈ kernel + universal metrics + rubric pack   (~3k, CACHED)
            + rendered input snapshot                     (chart JSON: ~5–10k)
            + candidate output                            (up to 16k)
            + silver output                               (up to 16k)

judge_output ≈ ~15 metrics × evidence bundle + overall
             where a bundle averages ~2 candidateQuotes, ~2 inputRefs,
             occasional referenceQuotes/absences, + a 60-word rationale
             ≈ ~230 tokens/metric  →  ~3.5k, plus thinking tokens
```

**The evidence contract is the main driver of judge output cost**, and it raised it by roughly
75% over a single-quote design (~2k → ~3.5k tokens/call). That is a deliberate trade: multiple
quotes, reference quotes, multiple input facts and explicit absence claims are what make
[Report 5](04-reporting-and-human-review.md#report-5--evidence-drill-down) possible, and
Report 5 is the only mechanism by which a human can establish that the judge is *right* rather
than merely self-consistent. An unfalsifiable judge is worth less than the ~$400 the richer
evidence adds to a full sweep.

The knobs, if that trade needs revisiting: `judge.maxQuotesPerMetric` (default 4) and
`judge.maxInputRefsPerMetric` (default 6). Lowering them reduces cost and directly reduces
what Audit 4 can verify. Do not lower them below 2 — a single-quote cap makes
`internal_consistency` unevidenceable, since a contradiction needs both sides.

### The caching finding — state it plainly

Prompt caching helps far less than it appears to, and only on the small tracks:

| Track | Cached prefix | Total judge input | Prefix share |
|---|---|---|---|
| `numerology_brief` | ~3k | ~8k | **~38%** — caching is a real saving |
| `natal_detailed` | ~3k | ~45k | **~7%** — caching is close to irrelevant |

Note the corollary for the small tracks: on `numerology`, judge **output** (~3.5k) now exceeds
judge **input after caching**, and output is priced ~5× higher. So on the twelve numerology
rows per user, cost is dominated by the evidence bundle, not by the reading. That is the
opposite of the chart tracks, and it means the two ends of the suite respond to entirely
different levers.

The cache prefix is fixed-size while the volatile payload scales with the reading. So caching
is worth having and must be verified, but it is **not** the lever that controls judge cost on
the expensive tracks. The levers that actually matter there are batch mode and the silver
reference.

**The silver reference roughly doubles judge input on the large tracks.** That is the real
price of the reference-based design. It interacts directly with the contamination check in
[02-metric-suite/02](../02-metric-suite/02-silver-similarity-metrics.md#1-reference-contamination-check):
if that check shows no anchoring, the universal metrics can be scored in a
`includeSilverReference: false` pass and the comparative metrics run only where they add
value — which is the single largest available judge-cost reduction on `natal`, `transit`,
`synastry` and `composite`.

### Order-of-magnitude estimate

**Illustrative only.** Assumes a judge at roughly $5/$25 per MTok list, batch mode at 50%
(→ $2.50/$12.50 effective), and mid-range actual output lengths. Replace with the real
`rates` table before quoting any of this.

| Item | Input | Output | Estimate |
|---|---|---|---|
| Judge call, `numerology_*` | ~8k | ~3.5k | ~$0.06 |
| Judge call, brief chart track | ~20k | ~3.5k | ~$0.09 |
| Judge call, detailed chart track | ~45k | ~3.5k | ~$0.16 |
| **Per user, per arm** (27 rows) | | | **~$2.20** |
| 100 users × 4 arms (champion + 3 challengers) | | | ~$880 |
| \+ silver as a blind arm (5th) | | | ~$1,100 |
| \+ 10% re-judge and 10% cross-judge | | | **~$1,320** |

**A full sweep lands around $1,300.** That is small against the decision it informs — a
per-track model change across the reading surface. Worth stating explicitly to whoever
approves the spend: the evaluation is cheap; the wrong model choice, at production volume,
is not.

Re-running stages 4–8 — re-weighting the composite, moving a threshold, regenerating every
report and audit — costs **nothing**. Only stage 3 spends. So the sweep is run once and the
decision can be argued about indefinitely.

Challenger *generation* cost is separate and is not incurred by this repo — the challenger
outputs already exist in their table.

## 5. Quality-per-dollar, defined

The decision rule is **not** a quality/cost ratio. Two reasons, and the first is decisive:

1. **`composite_quality` is an interval scale, not a ratio scale.** A 1–5 rubric score has no
   meaningful zero, so `quality / cost` is not a well-defined quantity — rescaling the rubric
   to 0–4 or 1–10 changes the ranking. Any metric that reorders under a legitimate rescaling
   of its input is not measuring anything.
2. A ratio lets a very cheap, mediocre model outrank a modestly-more-expensive good one, and
   silently trades away quality floors that were set deliberately.

So quality-per-dollar is operationalised as the **lexicographic rule** in
[02-statistical-design.md §6](02-statistical-design.md#6-decision-support--what-the-engine-computes-who-decides): gates eliminate,
degeneracy eliminates, quality establishes eligibility within an explicit margin, and cost
selects among the eligible. `qualityMarginDelta` is the one knob that expresses how much
quality you are willing to pay for — and it is visible in config rather than buried in an
arithmetic form.

The report presents the frontier so the knob can be argued about with evidence: for each
track, a table of surviving models with `composite_quality` + CI, cost per reading, and
latency, with the selected model marked and the margin that selected it stated.

## 6. Estimate before you spend

`--estimate` runs stages 1–2 only (no LLM calls) and prints, per shard: row count, projected
judge input/output tokens, projected cost at the configured rates, and projected cache-hit
savings.

**Required before any full sweep.** With 10,800 judge calls in play, discovering the cost
after the fact is not a plan. The estimate is also the cheapest way to catch a renderer
regression — a snapshot renderer that stops stripping SVG blobs from `chartDetails` shows up
immediately as a token-count jump, long before it shows up as a bill.
