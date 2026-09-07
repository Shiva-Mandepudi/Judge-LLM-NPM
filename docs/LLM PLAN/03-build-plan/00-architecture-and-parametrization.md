# Architecture, Modularity and Parametrization

A standalone repo. **Zero code dependency on CosmicGuidance** — it reads the silver and
challenger tables and its own config, and nothing else. That independence is both the
integrity property and the portability property: the engine contains no astrology, no
numerology and no tarot, so pointing it at a future Shunyaverse product means adding config,
not forking code.

Suggested name: `shunyaverse-eval` — product-neutral on purpose. TypeScript, for team
familiarity; it imports nothing from the CG codebase.

## The core / adapters split

The repo is two halves with a one-way dependency:

```
        ┌─────────────────────────────────────────┐
        │  core/   the reusable evaluation engine │
        │  judging · evidence · scoring · stats   │
        │  cost · audit · reports                 │
        │  knows: rows, metrics, gates, clusters  │
        │  knows nothing about astrology          │
        └────────────────▲────────────────────────┘
                         │  implements ports
        ┌────────────────┴────────────────────────┐
        │  adapters/cosmic-guidance/              │
        │  datasource · renderers · strata ·      │
        │  track configs · rubric packs           │
        └─────────────────────────────────────────┘
```

**`core/` must never import from `adapters/`.** That single rule is what makes the engine
reusable for ShunayaVerse's other products: a new product is a new adapter directory plus
config, and the engine is untouched.

Two tests enforce it, because this boundary erodes silently:

1. **Dependency direction** — static check that no file under `src/core/` imports from
   `src/adapters/` or from any adapter package.
2. **Domain vocabulary** — grep `src/core/` for `natal`, `transit`, `synastry`, `composite`,
   `tarot`, `numerology`, `zodiac`, `my_day`, `chart`, `birth`. Any hit outside a fixture
   fails the build.

Crude, and they are the tests that keep this reusable. Without them, track-specific branching
accretes in the engine within two sprints and the repo becomes a CG-only tool.

`core/` is publishable on its own (`@shunyaverse/eval-core`); the CG adapter depends on it,
never the reverse.

### The ports

Everything product-specific enters through one of five interfaces. `core/` defines them;
adapters implement them. Nothing else crosses the boundary.

| Port | Signature (essence) | CG adapter supplies |
|---|---|---|
| `Datasource` | `listUsers() → UserId[]`<br>`fetchRows(track, users) → RawRow[]` | Postgres queries against the silver and challenger tables |
| `Renderer` | `render(raw) → RenderedContent` | per-reading rendering of input snapshot and output into ordered, field-addressable sections |
| `Stratifier` | `stratumOf(raw) → Stratum` | chart complexity, `numberType`, moon phase, spread type, sun sign |
| `TrackSpec` | declarative — loaded from YAML, not code | the 17 track configs + rubric pack paths |
| `JudgeProvider` | `score(payload, schema) → Judgement` | *not* a CG concern — a provider adapter (Anthropic / OpenAI / Gemini), swappable the same way |

`JudgeProvider` being a port matters as much as `Datasource`: the judge model must be
swappable without touching the engine, both for the cross-vendor agreement check and because
judge independence may force a different vendor later.

`RenderedContent` is the pivot type — the one thing every adapter must produce and the only
shape `core/` understands:

```ts
type RenderedContent = {
  sections: Array<{ name: string; path: string; text: string }>;  // stable order
  fields:   Record<string, string | number | boolean | null>;     // addressable for inputRefs
  text:     string;                                               // the rendered whole
}
```

`fields` is what makes `evidence.inputRefs[].field` resolvable and
`inputRefs[].value` checkable ([01-judge-prompt/01](../01-judge-prompt/01-output-contract.md#post-parse-validation--reject-never-repair)).
`sections` is what makes `absences[].scope = section_missing` an exact lookup rather than a
judgement. Both validation guarantees are properties of this type, so they hold for **any**
product whose adapter produces it — the evidence contract is portable, not CG-specific.

## Repo layout

```
shunyaverse-eval/
├── packages/
│   ├── core/                              @shunyaverse/eval-core — product-agnostic
│   │   ├── contracts/     Row · RenderedContent · Payload · Judgement · Evidence
│   │   │                  MetricSpec · TrackSpec · GateSpec · port interfaces
│   │   ├── registry/      track loader, prompt composer, output-schema generator
│   │   ├── judge/         JudgeProvider port, batch runner, retry, cache management
│   │   ├── evidence/      verbatim-quote check, absence resolution, inputRef resolution
│   │   ├── metrics/       parsing, abstention handling, composite computation
│   │   ├── stats/         cluster bootstrap, CIs, paired deltas, agreement, multiplicity
│   │   ├── cost/          rate table, per-reading / per-user / consolidated rollups
│   │   ├── audit/         slice sampler, review import, component-audit computations
│   │   └── report/        renderers + threshold-sensitivity engine
│   ├── providers/         JudgeProvider implementations (anthropic · openai · gemini · mock)
│   └── adapters/
│       └── cosmic-guidance/
│           ├── datasource.ts    Postgres against CG silver + challenger tables
│           ├── renderers/       one per reading shape → RenderedContent
│           ├── strata.ts        CG stratification
│           ├── tracks/          the 17 TrackSpec YAMLs
│           └── prompts/         rubric packs (CG-specific)
├── prompts/kernel/                        product-agnostic: kernel, universal, comparative
├── config/                                run · models · metrics · thresholds
├── runs/<runId>/                          artifacts
└── test/
    ├── boundary/          dependency-direction + domain-vocabulary tests
    └── synthetic/         known-effect datasets for the statistics gate
```

The three prompt layers land on the right side of the boundary by construction: the kernel,
universal metrics and comparative metrics are **product-agnostic** and live in `prompts/kernel/`;
only the rubric packs are CG-specific and live in the adapter. That is the hybrid prompt design
([01-judge-prompt/00](../01-judge-prompt/00-universal-kernel.md#assembly)) paying off as a
packaging property — a new product reuses two-thirds of the prompt unchanged.

## Pipeline stages

Each stage reads the previous stage's artifact and writes its own. Every stage is
independently re-runnable, which is what makes a 2,700 × (k+1) sweep operationally survivable.

| # | Stage | Reads | Writes | LLM? |
|---|---|---|---|---|
| 1 | `materialize` | silver + challenger tables, track configs | `rows.jsonl` | no |
| 2 | `render` | `rows.jsonl` | `payloads.jsonl` (blinded) | no |
| 3 | `judge` | `payloads.jsonl` | `judgements.jsonl` | **yes** |
| 4 | `validate` | `judgements.jsonl` | `scores.jsonl`, `invalid.jsonl` | no |
| 5 | `stats` | `scores.jsonl` | `stats.json` | no |
| 6 | `cost` | `rows.jsonl` + `judgements.jsonl` | `cost.json` | no |
| 7 | `audit` | `scores.jsonl` | `audit-slice.jsonl` → human → `audit-reviewed.jsonl` | no |
| 8 | `report` | `stats.json`, `cost.json`, `audit-reviewed.jsonl` | report bundle — spec in [04](04-reporting-and-human-review.md) | no |

Only stage 3 costs money. Stages 4–8 are free and can be iterated on a completed sweep as
often as needed — which matters, because rubric weights, thresholds and decision margins will
be argued about after the numbers exist.

### Run artifacts

```
runs/<runId>/
├── manifest.json      run config snapshot + SHA-256 of every prompt file + git SHA
├── rows.jsonl         one line per (user, track, stratum, modelRef)
├── payloads.jsonl     exact judge payloads — blinded
├── judgements.jsonl   raw judge responses + usage + cost
├── scores.jsonl       validated, parsed metrics
├── invalid.jsonl      rejected judge responses, with reason
├── stats.json         means, CIs, deltas, agreement, gate rates
├── cost.json          per-reading / per-user / consolidated + judge cost
├── audit-slice.jsonl  sampled rows for human review
├── report.md          the readable deliverable
└── modelmap.sealed.json   modelRef → model  (NOT read before stage 5)
```

`manifest.json` pins the run. Scores produced under different prompt hashes are **not
comparable**, and `report` refuses to pool them rather than silently averaging across a
prompt change.

## Row shape — the atom of the system

```jsonc
{
  "rowId": "sha256(runId|userId|track|stratumKey|modelRef)",
  "runId": "...",
  "userId": "u_014",           // the CLUSTER key — see 02-statistical-design.md
  "track": "numerology_detailed",
  "stratum": { "numberType": "life_path", "numberValue": 11, "masterNumber": true },
  "modelRef": "arm-2",         // opaque until stage 5
  "inputSnapshot": { ... },
  "candidateOutput": { ... },
  "silverOutput": { ... },
  "generation": { "inputTokens": 0, "outputTokens": 0, "latencyMs": 0 },
  "loadStatus": "ok"           // ok | unparseable | missing_candidate | missing_silver
}
```

`userId` on every row is what makes the cluster bootstrap possible. It is not incidental
metadata — it is the design.

`loadStatus` is mechanical, not evaluative. `unparseable` rows are never judged and are
reported as a rate per (track, model). See
[README](../README.md#two-decisions-taken-as-given).

## Blinding

The integrity mechanism, in three parts:

1. `modelRef` (`arm-0`, `arm-1`, …) is assigned at materialization and shuffled per run.
2. `modelmap.sealed.json` holds the mapping and is **not read by stages 2–4**. Enforced by
   the module boundary: `core/judge/` and `core/evidence/` cannot import the resolver.
3. A test scans `payloads.jsonl` for every string in `models.yaml` and fails on a hit.

The champion is just another arm. It gets no label, no ordering advantage, and the judge
cannot tell it apart. Silver, when run as a blind arm
([02-metric-suite/02](../02-metric-suite/02-silver-similarity-metrics.md#2-score-the-silver-reference-as-a-blind-arm)),
gets a `modelRef` from the same pool.

## The four config artifacts

### `config/models.yaml`

```yaml
champion:
  modelId: "TODO"          # stated as "5.6 sol" — fill in the exact provider model ID
  label: "champion"

challengers:
  - modelId: "..."
  - modelId: "..."

includeSilverAsBlindArm: true

judge:
  primary:
    provider: "..."        # MUST differ in family from champion, challengers and the
    modelId: "..."         # silver generator — see the note below
    effort: "high"
    thinking: "adaptive"
  secondary:               # cross-vendor, agreement subsample only
    provider: "..."
    modelId: "..."
    sampleRate: 0.10

rates:                     # USD per 1M tokens; unknown model ⇒ cost reported as `unknown`
  "<modelId>": { input: 0.0, output: 0.0, cacheRead: 0.0, cacheWrite: 0.0 }
```

> **Judge independence is a hard constraint, not a preference.** A model scores outputs
> resembling its own style more favourably. The judge must therefore differ in vendor family
> from (a) every candidate, (b) the champion, and (c) the silver generator. The champion is
> recorded as `5.6 sol`; **its exact family must be confirmed before the judge is chosen**,
> because if the judge shares that family the bias lands directly on the incumbent and the
> whole sweep is compromised. The cross-vendor agreement check in
> [02-statistical-design.md](02-statistical-design.md#4-judge-reliability) is the standing
> detector, but it cannot repair a bad primary choice.

### `config/tracks/<track>.yaml`

```yaml
track: numerology_detailed
label: "Numerology Detailed Reading"
purpose: "Interpretation of one numerology number across four to five life themes."
depth: detailed

datasource:
  silver:    { table: "...", outputColumn: "detailed_insight", userKey: "..." }
  challenger:{ table: "...", outputColumn: "detailed_insight", userKey: "..." }
  input:     { table: "...", columns: ["number_type", "number_value", "year"] }

renderer: numerology            # from src/materialize/renderers
strata: [numberType]
rowsPerUser: 6

prompt:
  rubricPack: prompts/rubric-packs/numerology.md

metrics:
  supplements:
    - { key: canonical_meaning_fidelity, gate: hard }
    - { key: master_number_handling,     gate: hard, conditionalOn: "stratum.masterNumber == true" }
    - { key: number_type_discipline,     gate: soft }
    - { key: year_anchoring,             gate: soft, conditionalOn: "stratum.numberType == 'personal_year'" }

sampling:
  mode: exhaustive               # numerology only; every other track uses `stratified`
```

### `config/thresholds.yaml`

```yaml
composite:
  weights: { personalization: 1.0, internal_consistency: 1.0, voice_alignment: 1.0,
             usefulness: 1.0, language_quality: 1.0 }
  requireAllScored: true

gates:
  maxFailureRateUpperBound: 0.0     # zero tolerance at the CI upper bound
decision:
  qualityMarginDelta: 0.25          # cheapest model within this of the leader wins
  maxDegenerateRate: 0.02
statistics:
  bootstrapIterations: 10000
  confidenceLevel: 0.95
  clusterBy: userId
  multiplicityCorrection: benjamini-hochberg
judgeReliability:
  rejudgeSampleRate: 0.10
  minSelfAgreementWithinOne: 0.90
  minCrossJudgeAgreementWithinOne: 0.70
```

### `config/run.yaml`

```yaml
runId: "2026-09-05-sweep-01"
users: 100
tracks: [ ... ]                    # subset or all 17
models: { fromModelsYaml: true }
prompt: { includeSilverReference: true, cacheBreakpointAfter: rubric_pack }
execution:
  mode: batch                      # batch | interactive
  shardBy: track
  maxConcurrentShards: 4
  resume: true
stages: [materialize, render, judge, validate, stats, cost, audit, report]
```

## Scalability mechanics

A full sweep is 2,700 × (k+1) judge calls. At k=3 that is 10,800. These are the controls that
make it routine rather than an event.

| Mechanism | Detail |
|---|---|
| **Batch API** | default execution mode. ~50% cost reduction and no latency requirement in an offline system. Not an optimization — the baseline. |
| **Prompt caching** | kernel + universal metrics + rubric pack is a byte-identical prefix per track; cached reads cost a fraction of fresh input. Asserted, not assumed: the run fails loudly if `cacheReadInputTokens` is zero after the first N calls of a shard. |
| **Sharding** | by track (17 natural shards) or by user range. Independent, parallel, individually resumable. |
| **Idempotency + resume** | `rowId` is the idempotency key. A resumed run skips completed rows. A 10,800-call sweep must never be all-or-nothing. |
| **Checkpointing** | `judgements.jsonl` is append-only and flushed per batch. |
| **Rate-limit handling** | per-provider token-bucket + exponential backoff on 429/5xx. |
| **Stage isolation** | stages 4–8 re-run free. Re-weighting the composite or moving a threshold costs nothing after the sweep. |
| **Dry-run** | `--estimate` runs stages 1–2 and prints projected token and dollar cost per shard before anything is spent. Required before any full sweep. |

## Portability beyond CosmicGuidance

To evaluate a different ShunayaVerse product, add one adapter directory:

| Step | Deliverable |
|---|---|
| 1 | Implement `Datasource` for its store — two methods |
| 2 | Implement `Renderer` per output shape, producing `RenderedContent` |
| 3 | Implement `Stratifier` |
| 4 | Write `TrackSpec` YAML per track, and a rubric pack per track |
| 5 | Point `config/models.yaml` and `thresholds.yaml` at the new run |

Reused **untouched**: the universal kernel, the 8 universal metrics, the 4 comparative
metrics, output-schema generation, the whole evidence contract and its validation, the
cluster bootstrap and statistics, cost rollups, the audit sampler, and every report.

That is most of the system, and it is deliberate. The universal metrics were written to be
domain-neutral for exactly this reason — `personalization`, `internal_consistency`,
`usefulness` and `language_quality` are properties of any personalised generated content, not
of astrology. The same is true of the evidence contract: "quote what you scored, name the
input facts, declare what is missing" is product-independent.

What is **not** portable, and should not pretend to be: the rubric packs. What "grounded"
means is irreducibly domain knowledge, and that is precisely the thing the hybrid design
isolates into a swappable file.
