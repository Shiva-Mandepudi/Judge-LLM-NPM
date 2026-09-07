# Statistical Design

The job: decide, per reading, which model to ship — with an honest range around every number
and an explicit refusal to rank when the data cannot support a ranking.

## 1. The unit of analysis, and why clustering is the design

One **row** = one (user, track, stratum, model). One **cluster** = one **user**.

A user's rows are not independent. All 27 of them derive from the same birth chart and the
same numerology profile, so a user with an unusually clean chart, or an unusually
interpretable set of numbers, produces easier rows across the board. Treating those 27 rows
as 27 independent observations understates variance and produces confidence intervals that
are too narrow — the most common way an evaluation of this shape lies.

The correction is to resample **users**, not rows. Where it bites:

| Aggregation | Rows per user (m) | Effect of clustering |
|---|---|---|
| Single track, most tracks | 1 | none — cluster bootstrap reduces exactly to the ordinary bootstrap |
| Single track, `numerology_*` | 6 (one per `numberType`) | real — a user's six numbers share one name and birth date |
| Per-user rollup | 27 | **large** |
| Cross-track pooled | 27 | **large** |

The inflation is the design effect:

```
DEFF ≈ 1 + (m − 1) · ICC          n_effective ≈ n_rows / DEFF
```

At the rollup level with m=27, even a modest ICC of 0.10 gives DEFF ≈ 3.6 — so 2,700 rows
carry roughly the information of 750 independent ones. Report `ICC` and `n_effective`
alongside every pooled statistic; a reader who sees only "n = 2,700" will over-trust it.

**One procedure everywhere.** Resampling users is correct in all four cases above — it is
exact when m=1 and necessary when m>1. So the engine always cluster-bootstraps by user, and
there is no per-track branching to get wrong.

## 2. The paired cluster bootstrap

Every model sees the **same users**. That pairing is what buys precision, and the resampling
must preserve it: resample users once per iteration and take **all models' rows** for the
users drawn. Resampling each model's rows independently would throw away the pairing and
inflate the intervals for no reason.

```
Given: users U (|U| = n), models M, rows keyed (user, track, stratum, model)

for b in 1..B:                            # B = 10,000
    U* ← sample n users from U WITH replacement
    rows*(m) ← all rows for users in U*, for model m      # duplicates included
    for each model m, metric k:
        θ*[b][m][k] ← mean(score(rows*(m), k))            # scored rows only
    for each challenger c:
        Δ*[b][c][k] ← θ*[b][c][k] − θ*[b][champion][k]    # paired, same U*

CI_95(θ)  = 2.5th and 97.5th percentiles of θ*[·]
CI_95(Δ)  = 2.5th and 97.5th percentiles of Δ*[·]
```

Notes that matter in implementation:

- **A drawn user contributes all their rows every time they are drawn**, including duplicates.
  That is what propagates within-user correlation into the interval.
- **Percentile bootstrap** by default. Report BCa alongside for the composite when skew is
  material; do not silently switch — a changed interval type must be visible in the report.
- **Abstentions are excluded, never imputed.** Each resample's mean is over scored rows only,
  and the abstention rate is reported beside every mean.
- **Fixed seed per run**, recorded in `manifest.json`, so an interval is reproducible.
- **`B = 10,000`** for reported intervals. 1,000 is fine while iterating; the number used is
  recorded in the artifact.

### Proportions

Gate failure rates, `candidate_degenerate` rate, abstention rate and `unparseable` rate are
proportions. Bootstrap them the same way, **and** report a Wilson interval as a cross-check:
at the zero and near-zero counts we expect on hard gates, the bootstrap degenerates (every
resample returns 0, giving a false `[0, 0]`) while Wilson still gives a non-zero upper bound.
**For a zero-failure gate, the Wilson upper bound is the number that matters** — "0 failures
in 100" is not "0% failure rate", it is "at most ~3.6%".

## 3. What gets computed

Per `(track, model)`:

| Statistic | Interval |
|---|---|
| mean of each universal soft metric | cluster bootstrap CI |
| `composite_quality` | cluster bootstrap CI |
| `track_supplement_mean` (soft supplements) | cluster bootstrap CI |
| failure rate of each hard gate | bootstrap + **Wilson** |
| abstention rate per metric | bootstrap |
| `candidate_degenerate` rate, `substantive_disagreement` rate | bootstrap |
| `reference_advantage` mean | cluster bootstrap CI |
| paired Δ vs champion, per metric and composite | **paired** cluster bootstrap CI |
| cost per reading (median, p95) | bootstrap on the median |
| latency (median, p95) | bootstrap on the median |

Per `(user, model)` → per model: `composite_quality` across that user's tracks, and **total
cost to serve that user's full reading set** — see
[03-cost-analysis.md](03-cost-analysis.md#2-per-user-rollup).

## 4. Judge reliability

**The judge is an instrument and its noise is the resolution floor.** A model difference
smaller than judge noise is not a finding. This is measured, not assumed.

| Check | Design | Threshold |
|---|---|---|
| **Self-agreement** | re-judge a 10% row subsample with the identical judge and config | ≥90% of metric scores within ±1; report exact-agreement too |
| **Cross-judge agreement** | a different-vendor secondary judge scores the same 10% | ≥70% within ±1 |
| **Gate agreement** | agreement on hard-gate pass/fail over the same subsample | tracked separately — a gate disagreement is far more serious than a ±1 score disagreement |

From the re-judge sample, compute the **judge noise band** as the SD of paired
same-row re-score differences, per metric. Then:

```
if |Δ(model, champion)| < noise_band(metric)  →  report "indistinguishable"
```

The report states this explicitly rather than presenting an unresolvable ordering. Ranking
models inside the noise band is the single easiest way for this system to produce a confident
wrong answer.

Low cross-judge agreement on a metric means **the rubric anchors for that metric are
ambiguous**. The response is to fix the rubric wording and re-run, not to lower the threshold.
Rows where the two judges disagree on a gate go straight into the human audit slice.

## 5. Numerology is exhaustive, not sampled

`numerology_brief` and `numerology_detailed` have a **finite input space**: 71 canonical
values × 2 depths = **142 distinct pieces of content**. And that content is generated once
and served to every future reader with that number — an error does not average out over
future traffic, it compounds indefinitely.

So for these two tracks:

- Evaluate **all 142**. No sampling, and no coverage CI — coverage is 100% by construction.
- Confidence intervals still apply to the *judge's* uncertainty about quality, not to
  sampling uncertainty. Say which is which in the report; conflating them here is a category
  error.
- **Every master-number case (11, 22, 33) is reviewed by a human**, not sampled. That is 30
  of the 142 and they are where the errors are.
- Any hard-gate failure on any of the 142 blocks that model for that track outright. There is
  no failure-rate threshold to hide behind when the denominator is the entire universe.

The 100-user grid is how these 142 cases get *distributed* across users, not a reason to
sample them. Where 100 users do not naturally cover all 71 values, the stratifier must
synthesise coverage — `sampling.mode: exhaustive` in the track config
([00-architecture](00-architecture-and-parametrization.md#configtrackstrackyaml)).

## 6. Decision support — what the engine computes, who decides

**The engine does not decide. It computes a recommendation and everything needed to
challenge it.** A human reviews the consolidated score, the individual metrics, and each
component of the system independently, then makes the call — see
[04-reporting-and-human-review.md](04-reporting-and-human-review.md).

The four inputs below are never collapsed into one scalar before the recommendation. A single
blended score is exactly how a safety failure gets bought off by good prose, and it also
destroys the reviewer's ability to see *why* a model was recommended.

### The recommendation procedure

Run per track, mechanically, and reported with the evidence for every branch taken:

```
STEP 1 — FLAG on gates.
  For each hard gate: if the Wilson UPPER BOUND of the failure rate exceeds
  thresholds.gates.maxFailureRateUpperBound (default 0.0), the model is FLAGGED for that
  track. Upper bound, not point estimate: "zero observed failures" is not "zero failure
  rate". Every flag carries the failing rows and their evidence, so the reviewer reads the
  actual violation rather than a rate.

STEP 2 — FLAG on degeneracy.
  If the `candidate_degenerate` rate upper bound exceeds decision.maxDegenerateRate, the
  model is FLAGGED — regardless of its mean scores.

STEP 3 — RANK on quality among unflagged models.
  leader = argmax composite_quality (point estimate).
  A model is QUALITY-ELIGIBLE if:
      CI_upper(composite_quality) ≥ composite_quality(leader) − decision.qualityMarginDelta
  i.e. it cannot be ruled out as within `qualityMarginDelta` of the leader.

STEP 4 — RECOMMEND on cost.
  Among quality-eligible unflagged models, the lowest cost-per-reading is RECOMMENDED.
  Ties on cost break on median latency.

STEP 5 — WITHHOLD a recommendation where the data does not support one.
  If all candidates are inside the judge noise band of each other, do not rank them. Report
  "indistinguishable on quality; cost is the only separator" in the headline.
  If every model is flagged in Steps 1–2, report NO RECOMMENDATION and escalate. The engine
  never relaxes a gate to produce an answer — only a human may accept a flagged model, and
  that acceptance is recorded.
```

### Thresholds are defaults, not findings

Every threshold in `thresholds.yaml` is a **product-value judgement**, not a statistical
fact. `qualityMarginDelta: 0.25` says "we will pay for a quarter-point of rubric quality";
`maxFailureRateUpperBound: 0.0` says "no tolerated gate failures". Those are calls for the
reviewer to make, so the report must not present them as settled.

Hence the **threshold-sensitivity table**, produced per track: how the recommendation changes
as each threshold varies over a declared sweep. A recommendation that is stable across the
sweep is a strong result; one that flips between `qualityMarginDelta` 0.2 and 0.3 is a
coin-toss dressed as a decision, and the reviewer needs to see that. Spec in
[04 §Report 3](04-reporting-and-human-review.md#report-3--per-track-model-comparison).

### Independence across tracks

Every track is recommended **independently**. There is no global winner and there should not
be: `numerology_brief` takes one integer and ~2,000 output tokens; `natal_detailed` takes a
full chart and runs at `maxOutputTokens: 16000`. Expecting one model to be optimal for both
is not a hypothesis anyone should hold.

The reviewer may still choose a uniform model for operational simplicity — that is a
legitimate call the report supports by showing the per-track cost of doing so.

## 7. Multiplicity

17 tracks × k challengers is a large family of simultaneous decisions. At k=3 and α=0.05,
roughly 2–3 of 51 comparisons will look significant by chance alone.

- Apply **Benjamini–Hochberg** across the family of **primary** tests only: the paired
  composite-quality delta per (track, model). BH controls false discovery rate, which is the
  right target when the output is a ranked shortlist rather than a single hypothesis test.
- **Do not correct the diagnostics.** Per-metric means, supplements, abstention rates and
  similarity diagnostics are descriptive; correcting them would suppress exactly the signal
  the human audit slice needs.
- **Do not correct the gates.** They are eliminators with zero tolerance, not hypothesis
  tests, and a multiplicity adjustment on a safety gate is indefensible.
- Report both raw and adjusted p-values with the correction named.

## 8. Power, and calibrating n

Sample size is **derived from a pilot, not declared**.

For a single track, each user contributes one row, so `n = users = 100` and the paired
standard error is:

```
SE(Δ) = SD(paired per-row difference) / √n
```

An SD of ~0.6 on the paired difference gives `SE ≈ 0.06` and a 95% half-width of ≈0.12 —
comfortably able to resolve the default `qualityMarginDelta` of 0.25. That SD is an
assumption until measured.

So: **Phase 2 runs a pilot at n≈30, measures the paired SD and the judge noise band per
metric, and back-computes the n needed per track.** Tracks with high variance will need more
users than 100; low-variance tracks may need fewer. For `numerology` the question does not
arise — n is the entire input space.

For the per-user rollup, `n_effective = n_rows / DEFF`, with DEFF measured from the observed
ICC. Report it.

## 9. What the report must refuse to do

Written down because each of these is a live temptation once stakeholders want a clean answer:

| Refuse | Because |
|---|---|
| Pool scores across different prompt hashes | different rubric text is a different instrument; `manifest.json` makes this detectable and `report` must hard-fail on it |
| Impute an abstention to the mean or midpoint | manufactures data and destroys the abstention-rate signal |
| Rank models whose intervals overlap inside the judge noise band | presents instrument noise as a finding |
| Report a cost comparison when any model's rate is `unknown` | a missing rate must surface as `unknown`, never as zero |
| Present a single blended "score" combining quality, safety and cost | the whole point of the four-step rule is that these are not commensurable |
| Average `composite_quality` across tracks without reporting `n_effective` and ICC | invites over-trust in a clustered sample |
| Call a gate "passed" from zero observed failures without the Wilson upper bound | 0/100 is an upper bound of ~3.6%, not 0% |
