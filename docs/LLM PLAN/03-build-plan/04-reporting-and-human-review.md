# Reporting and Human Review

**The engine recommends. A human decides.** Nothing ships on a computed threshold.

That places two obligations on this system. First, the report must carry every statistic
needed to accept or overturn each recommendation — including the statistics that would
embarrass it. Second, **every component must be auditable on its own**: a reviewer must be
able to interrogate the dataset, the prompts, the judge, the evidence, the metrics, the
statistics, the cost model and the gates *independently*, without taking any of the others on
trust. A single end-to-end "trust the pipeline" report is not acceptable, because a failure
anywhere upstream is invisible in the aggregate.

The report bundle is therefore two things: **seven decision reports** and **eight independent
component audits**.

---

# Part A — The seven decision reports

Emitted as `report.md` (readable), `report.json` (machine-readable, every number addressable),
and `report.html` (drill-down navigation). All three are generated from `stats.json`,
`cost.json` and `audit-reviewed.jsonl` — stage 8, free to re-run, so weights and thresholds
can be re-argued after the sweep without re-judging anything.

## Report 1 — Consolidated decision brief

One page. What a reviewer reads first, and what they sign.

| Element | Statistics shown |
|---|---|
| Per-track recommendation table | 17 rows: recommended model, `composite_quality` + 95% CI, Δ vs champion + CI, gate flag count, cost/reading, latency p50 |
| Headline cost | `cost_per_user` for `champion_uniform` vs `per_track_optimal`, median + p95 + CI on the median, and Δ with CI |
| Consolidated monthly projection | with volume assumptions printed inline, marked **partial** where any track's volume is unknown |
| Confidence banner | count of tracks recommended / withheld / no-recommendation; overall judge self-agreement and cross-judge agreement; whether the sanity-floor arm ranked last |
| Blocking issues | any failed component audit from Part B, named, with a link |

**The confidence banner is above the recommendations, not in an appendix.** If judge
agreement failed or the sanity-floor arm did not rank last, the reviewer must see that before
reading a single recommendation.

## Report 2 — Per-user cost rollup

| Element | Statistics |
|---|---|
| Cost per user, per configuration | median, p95, cluster-bootstrap CI on the median |
| Distribution | histogram + the p95 user's composition, showing which readings drive the tail |
| Contribution by track | share of `cost_per_user`, per track — the four detailed chart tracks are expected to dominate at ~47% of output tokens ([03-cost-analysis](03-cost-analysis.md#output-token-envelope-per-track)) |
| Reading count actually observed | per user, per track, with `unparseable` and `missing_*` rates |

## Report 3 — Per-track model comparison

The workhorse. One section per track, and the reviewer is expected to read the tracks they
care about in full.

| Element | Statistics |
|---|---|
| Model × metric matrix | every model × every metric: mean, 95% CI, n scored, abstention rate |
| Composite | `composite_quality` + CI; paired Δ vs champion + CI; raw and BH-adjusted p-value |
| Supplements | `track_supplement_mean` + CI, and each supplement individually |
| Gates | per gate: failure count, rate, **Wilson upper bound**, and a link to every failing row's evidence |
| Similarity axis | `reference_advantage` mean + CI; `silverComparison` category distribution; `candidate_degenerate` and `substantive_disagreement` rates |
| Cost & latency | cost/reading p50 and p95, tokens p50, latency p50 and p95 |
| Quality–cost frontier | the surviving models plotted, recommendation marked, selecting margin stated |
| **Threshold-sensitivity table** | how the recommendation changes as `qualityMarginDelta` sweeps 0.10–0.50 and `maxFailureRateUpperBound` sweeps 0.00–0.05 |
| Recommendation trace | which STEP of §6 selected or withheld, in words |

The sensitivity table is what converts a threshold from a hidden constant into a reviewable
decision. A recommendation stable across the whole sweep is a strong result; one that flips
between 0.20 and 0.30 is a coin-toss dressed as a decision, and the reviewer must be able to
see which they are being handed.

## Report 4 — Per-metric view

Cuts the data the other way: one section per metric, across all tracks and models. This is
how a reviewer audits a *metric* rather than a model.

| Element | Statistics |
|---|---|
| Score distribution | histogram per (track, model) — the discrimination check |
| Discrimination | SD and entropy of the score distribution; **flagged if >80% of scores fall on one value** |
| Abstention | rate per (track, model), broken out by `abstainReason` |
| Judge agreement | self-agreement and cross-judge agreement **for this metric specifically** |
| Noise band | SD of paired re-judge differences, beside the between-model spread |
| Evidence-channel mix | share of scores evidenced by quote / absence / reference-quote / combination |
| Redundancy | correlation with every other metric on the same rows |

Two findings this report exists to surface, both of which invalidate a metric rather than a
model:

- **A metric that does not discriminate is not measuring anything.** If every model scores
  4.1–4.3 on `voice_alignment` with a tight SD, that metric is contributing noise to the
  composite and its weight should be reconsidered.
- **Two metrics correlating above ~0.9 are one metric.** That is the halo effect the kernel's
  scoring-discipline rules try to prevent, measured. High correlation means the composite is
  double-counting and effectively re-weighting itself.

## Report 5 — Evidence drill-down

Every score is traceable to the evidence that produced it. Navigable from any cell in
Reports 3 and 4.

For a selected row: the rendered input, the candidate output, the silver reference, and per
metric — the score, the `candidateQuotes` (highlighted in place in the output), the
`referenceQuotes` (highlighted in the reference), the `inputRefs` (resolved to their values
in the input), the `absences`, the rationale, the gate verdict, and the raw judge response.

Plus the validation verdict per evidence item: whether each quote passed the verbatim check,
whether each `inputRefs[].field` resolved, whether each `inputRefs[].value` matched, and whether each
absence was exactly verified or is semantic-and-flagged.

**This is the report that makes the judge falsifiable.** Without it, a reviewer can only
agree or disagree with a number. With it, they can read the quote and see whether the judge
was right — which is the only way trust in an LLM judge is ever legitimately established.

## Report 6 — Reliability and validity appendix

Everything from Part B's audits 3, 4 and 6, gathered for reference, plus the run manifest:
prompt hashes, config snapshot, git SHA, bootstrap seed, `B`, and the model map (revealed
only here, and only after scoring).

## Report 7 — Sign-off sheet and decision log

The artifact the human produces, not consumes.

Per track: the recommendation, a decision field (`accept` / `override` / `defer`), the chosen
model, a required free-text reason on any override, and the reviewer's identity and date.

Per component audit: `pass` / `fail` / `accepted-with-note`, with the note.

Written to `runs/<runId>/decisions.json` and **replayed into the final report** so the shipped
artifact records what a human actually decided and why — including every case where a
threshold was overridden. Over successive runs this log is the record of how the thresholds
were really calibrated, which is more honest than a constant in a YAML file.

---

# Part B — The eight independent component audits

Each answers one question about one component, from its own evidence, with a stated pass
condition. **Each is reviewable without trusting any other.** Computed in stage 7 and
rendered as its own section, so a reviewer can start with whichever component they doubt.

Any `fail` appears in Report 1's blocking-issues list. A failing audit does not silently
degrade a recommendation — it blocks it until a human accepts the failure explicitly.

### Audit 1 — Dataset

*Is the evaluation set sound before anything is judged?*

| Statistic | Pass condition |
|---|---|
| Silver/challenger row correspondence per track | 100% — every judged row has both arms on the same input |
| Stratum coverage vs the track's declared strata | every stratum populated; numerology covers **all 71 canonical values** |
| `loadStatus` breakdown | `unparseable` / `missing_*` rate reported per (track, model); no undisclosed exclusion |
| Input-snapshot identity across arms | byte-identical per row — if the arms saw different inputs, the comparison is void |
| PII scan | zero real birth dates/places; synthetic personas only |
| Duplicate detection | no duplicated `(userId, track, stratum)` |

### Audit 2 — Prompt

*Was the judge asked the right thing, and the same thing throughout?*

| Statistic | Pass condition |
|---|---|
| `kernelHash` / `rubricPackHash` / `schemaHash` | exactly one distinct value per track across the run |
| Composed-prompt sample | one fully-rendered system+user payload per track, printed for human reading |
| Blinding scan | zero model/provider/prompt-version strings in `payloads.jsonl` |
| Cache-prefix stability | `cacheReadInputTokens > 0` after the first calls of each shard |
| Rubric/schema key parity | generated schema keys == declared rubric keys, per track |

The printed composed prompt is deliberately part of the audit. A reviewer should read what
the judge was actually sent for at least one row per track — most rubric defects are obvious
on sight and invisible in aggregate scores.

### Audit 3 — Judge

*Is the instrument reliable, and is it independent?*

| Statistic | Pass condition |
|---|---|
| Self-agreement (10% re-judge) | ≥90% of metric scores within ±1; exact-agreement reported |
| Cross-judge agreement (10%, different vendor) | ≥70% within ±1, per metric |
| Gate agreement | reported separately per gate — a gate disagreement is far more serious than ±1 |
| Judge noise band | SD of paired re-judge differences, per metric |
| **Sanity floor** | the deliberately weak arm ranks **last on every track**. If not, results are void |
| Silver-as-blind-arm | silver's own scores; flagged if it outranks all challengers on all tracks by a uniform margin — the signature of judge/generator family affinity |
| Independence declaration | judge family ≠ champion family, challenger families, silver-generator family |
| `judgeStatus` breakdown | `invalid` / `error` rate per track, and retry outcomes |

### Audit 4 — Evidence

*Is the evidence real, or merely quote-shaped?*

| Statistic | Pass condition |
|---|---|
| Verbatim-quote pass rate (`candidateQuotes`) | ≥99% first-attempt; every failure listed |
| Verbatim-quote pass rate (`referenceQuotes`) | ≥99% |
| `inputRefs[].field` resolution rate | ≥99% resolve to a real field in `RenderedContent.fields` |
| `inputRefs[].value` match rate | reported — a mismatch means the judge misread the input, which is a distinct and serious failure from a bad score |
| Absence verification split | share of absences **exactly** verified (`section_missing`, `required_field_empty`) vs **semantic-and-flagged** (`input_fact_unaddressed`, `expected_element_absent`) |
| Semantic-absence spot-check | a human-reviewed sample of semantic absences, with the agreement rate stated |
| Evidence-channel mix per metric | reported — a metric evidenced almost entirely by rationale-with-one-quote is under-evidenced |
| Empty-evidence scores | **zero** — a score with no quote, absence or reference quote must have been rejected at validation |

Semantic absences are the one part of the evidence contract that cannot be fully mechanised
([01-judge-prompt/01](../01-judge-prompt/01-output-contract.md#post-parse-validation--reject-never-repair)),
so they get a human spot-check rather than assumed validity.

### Audit 5 — Metrics

*Is each metric measuring something, and something distinct?*

| Statistic | Pass condition |
|---|---|
| Score distribution per metric | flagged if >80% of scores on one value — no discrimination |
| SD and entropy per metric | reported; near-zero SD is a finding about the metric |
| Inter-metric correlation matrix | any pair >0.9 flagged as redundant / halo effect |
| Abstention rate per metric | flagged above a configured ceiling; conditional metrics reported against their **expected** abstention rate (e.g. `master_number_handling` should abstain on exactly the non-master rows) |
| Register reconciliation | computed counts match the stated **31 keys / 9 gate keys / 37 assignments / 11 gate assignments** ([02-metric-suite/01](../02-metric-suite/01-reading-specific-metrics.md#register-totals--authoritative)) |
| Composite weight sensitivity | how the per-track recommendation changes under alternative weightings |

Register reconciliation is a documentation-drift guard: config, docs and report must state the
same totals, and the audit fails if they diverge. This audit exists because they already did
once.

### Audit 6 — Statistics

*Are the intervals honest?*

| Statistic | Pass condition |
|---|---|
| **Bootstrap recovery on synthetic data** | recovers a known injected effect; interval covers the true value at the nominal rate |
| Cluster-resampling check | a user drawn twice contributes all their rows twice — verified, not assumed |
| ICC and DEFF | reported per aggregation level, with `n_effective` beside every pooled `n` |
| Wilson intervals present | every zero-count proportion has a non-`[0,0]` upper bound |
| Multiplicity | BH applied to primary deltas only; raw and adjusted p-values both shown |
| Seed reproducibility | re-running stage 5 on the same `scores.jsonl` reproduces every interval exactly |
| Abstention handling | no imputation anywhere; abstention rate printed beside every mean |
| Prompt-hash pooling guard | report hard-fails on mixed hashes rather than averaging across a prompt change |

The synthetic-recovery check is the one that cannot be skipped. A bootstrap with a subtle
resampling bug produces plausible, tight, wrong intervals, and **nothing else in this system
would reveal it.**

### Audit 7 — Cost

*Are the dollar figures real?*

| Statistic | Pass condition |
|---|---|
| Rate-table completeness | every model in the run has a rate; any `unknown` blocks the cost comparison |
| Billing reconciliation | computed judge cost vs the provider's actual invoice for the run, within a stated tolerance |
| Token accounting | Σ per-row tokens == run totals |
| Cache-saving realisation | projected vs actual `cacheReadInputTokens` saving |
| `--estimate` accuracy | pre-run projection vs actual, per shard |
| Volume-assumption disclosure | every consolidated figure states its `volume[track]` source, marked partial where unknown |

Billing reconciliation must be done at least once, on the first full sweep. Until then every
cost number is a model of cost, not a measurement, and the report says so.

### Audit 8 — Gates

*Do the gates work, and has each one ever fired?*

| Statistic | Pass condition |
|---|---|
| Planted-defect results | each of the **12 hard gates** catches its planted defect — orientation inversion, altered injected score value, wrong ruling planet, wrong day, missing section, fabricated placement, and so on |
| Firing count per gate | reported. **A gate that never fired anywhere is flagged as UNTESTED**, not as passed |
| Every firing reviewed | 100% of gate failures human-reviewed via Report 5 — gates are zero-tolerance, so the volume is small by construction and full review is affordable |
| False-positive rate | from that review, per gate |
| Cross-judge gate agreement | per gate, from Audit 3 |
| Conditional-gate correctness | conditional gates abstained on exactly the rows where they should |

**An untested gate is the most dangerous object in this system**: it appears in every report
as a passed check while having demonstrated nothing. Hence planted defects for all 12, and an
explicit UNTESTED label for any gate that has not fired on real data.

---

# What the reviewer is asked to do

A defined sequence, so review is repeatable rather than ad hoc:

1. Read Report 1's **confidence banner and blocking issues**. If a component audit failed,
   stop and resolve it — an aggregate built on a failed audit is not informative.
2. Work Part B in order 1 → 8. Each is self-contained; a reviewer may reject any one without
   reading the others.
3. Read Report 4 to satisfy themselves the **metrics** measure something distinct.
4. Read Report 5 for a sample of rows per track — enough to form an independent view of
   whether the judge is right, not merely consistent.
5. Review **every** gate firing (Audit 8).
6. Read Report 3 per track, including the threshold-sensitivity table.
7. Read Report 2 for the cost consequence.
8. Record a decision per track in Report 7, with a reason on every override.

Steps 1–3 audit *the system*. Steps 4–7 audit *the models*. That order is deliberate: model
comparisons are meaningless until the instrument has been accepted, and the most expensive
mistake available here is to argue about model rankings produced by a broken judge.
