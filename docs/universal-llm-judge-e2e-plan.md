# Universal LLM Judge Service — E2E Architecture and Delivery Plan

**Status:** Proposed implementation plan  
**Scope:** `judge-service/` and its future application adapters  
**Primary source of truth reviewed:** `judge-service/docs/LLM PLAN/`  
**Architecture reference reviewed:** `judge-service/docs/LLM PLAN/cosmic-guidance-judge-eval-system-flow-napkin-final.png`

## 1. Executive decision

The Judge service should become a **universal, offline, batch-only evaluation engine**.
Cosmic Guidance is the first application adapter, not the engine itself. A future product
must be able to plug in its own data source, rendering rules, deterministic checks, and
rubric pack without changing the universal judging, evidence validation, statistics, cost,
reporting, or human-decision code.

The canonical lifecycle is:

```text
Run configuration
    ↓
1. Generate / import data through the selected application adapter and its main source
    ↓
2. Materialize, pair, render, blind, pre-check, compose prompts, and judge through batches
    ↓
3. Validate evidence, aggregate metrics, calculate cost, report, and route decisions to humans
```

The picture supplied with this plan expands that lifecycle into eleven operational gates:

```text
Inputs
  → 1 Materialize + pair
  → 2 Render + blind
  → 3 Extract pre-checks
  → 4 Compose judge
  → 5 LLM judge
  → 6 Validate evidence
  → 7 Metric ledger
  → 8 Cost
  → 9 Statistics
  → 10 Decision support
  → 11 Human audit + decision
```

The following meanings must stay distinct:

| Concept | Meaning | Current/target rule |
|---|---|---|
| Generation arm | A model/prompt/output being evaluated: champion, challenger, or optional silver reference | Generation is application-owned and batch-only |
| Universal kernel | Product-neutral judging instructions and universal metrics | Reused by every application |
| Application/reading rubric | Instructions and metrics for one application or reading type | Supplied by an adapter/configuration |
| Primary/secondary judge | Two judge models used to measure the evaluation instrument's reliability | Primary normally scores every valid row; secondary is configurable, cross-vendor, and can be set to 100% |
| Cost model | Token, batch, pricing, retry, and roll-up accounting | Covers source generation and judge analysis; unknown is never zero |

The universal kernel and the application rubric are **two prompt layers in one composed judge
request**. They are not two sequential LLM calls. The primary and secondary judge models are
the two independent analysis models. Keeping these distinctions explicit prevents accidental
cost doubling and prevents application-specific rules from leaking into the core.

## 2. What exists today

### 2.1 Already implemented and reusable

| Area | Current implementation | Keep / improve |
|---|---|---|
| Service boundary | Private Express service with admin auth, Cloud Run deployment, separate `JUDGE_DATABASE_URL`, no production traffic | Keep |
| Security | Admin shared-secret auth, Cloud Tasks OIDC auth, HMAC calls to Cosmic Guidance, idempotency keys, structured logging | Keep; apply the same contract to generic adapters and batch callbacks |
| Configuration | Versioned admin config, provider bindings, thresholds, retry settings, sampling, secrets by reference | Keep; add application/run/batch mode as required fields |
| Provider abstraction | OpenAI, Anthropic, Gemini, and mock provider modules | Keep provider-neutral interface; replace direct completion as the production path with batch lifecycle methods |
| Core contracts | `RenderedContent`, `Row`, `Datasource`, `Renderer`, `Stratifier`, `JudgeProvider` ports | Keep; extend ports for source generation, pre-checks, batch jobs, and metric registries |
| Materialization | `server/core/pipeline/materialize.ts` creates stable row IDs and coverage records | Keep; generalize away from Cosmic Guidance assumptions and support multiple arms/reference rows |
| Rendering | `server/core/pipeline/render.ts` and Cosmic Guidance renderers produce sections, fields, and text | Keep; make renderer output immutable and sufficient for every evidence reference |
| Prompt documentation | Universal kernel, output contract, universal metrics, reading-specific packs, silver metrics | Keep as the specification; load/hash them at runtime rather than duplicating prose in code |
| Evidence validation | Verbatim candidate/reference quote checks, input field/value checks, absence checks, abstention rules | Keep; make it the mandatory post-batch acceptance gate |
| Mechanical checks | Schema, truncation, safety, numerology, date, and track-specific checks | Keep; separate universal checks from adapter checks and persist all results |
| Blinding | A/B label assignment and sealed model mapping exist in both legacy and rebuilt paths | Consolidate into one run-level sealed arm map |
| Statistics design | Cluster bootstrap, paired deltas, Wilson intervals, abstention handling, multiplicity, judge noise design | Implement as the only aggregate path |
| Human review design | Review queue, reports/audits planned, human decision is final | Complete the queue/report/decision contract and audit trail |
| Cost foundations | Usage columns, pricing snapshots, request-attempt ledger, cost APIs, pre-run estimates | Reconcile all paths and add batch-aware cost events |

### 2.2 Current data-generation and batch work

The repository contains a useful Cosmic Guidance batch prototype:

- `scripts/prepare-cg-batch-corpus.ts` builds synthetic actor inputs, calls Cosmic Guidance
  calculation/preparation endpoints, and prepares OpenAI Batch JSONL.
- `scripts/submit-prepared-openai-batch.ts` submits a prepared batch.
- `scripts/import-openai-batch.ts` imports output/error files and persists usage.
- `scripts/prepare-failed-batch-retry.ts` isolates failed requests for a retry batch.
- `artifacts/batches/` contains imported batch artifacts and retry artifacts.

This proves the repository can do a real batch lifecycle, preserve request artifacts, import
provider results, and retry failed lines. It is not yet the universal implementation because
the scripts hardcode Cosmic Guidance, OpenAI, a model, dates, tracks, prompt version, and
Cosmic Guidance-specific input construction.

### 2.3 Current judge analysis work

The rebuilt path also contains much of the intended evaluation instrument:

- `docs/LLM PLAN/01-judge-prompt/` defines the kernel, output contract, and rubric packs.
- `docs/LLM PLAN/02-metric-suite/` defines eight universal metrics, reading metrics, gates,
  and the optional silver-comparison axis.
- `server/core/judge/schema.ts` generates a structured output schema from metrics.
- `server/core/judge/validator.ts` rejects invalid evidence and abstention shapes.
- `server/core/judge/runner.ts` performs a provider call, validates it, and retries once.
- `server/adapters/cosmic-guidance/evidence-judge.ts` persists judge usage and results.
- `eval_judgements_v2` stores hashes, model identity, role, usage, status, and response.

These are strong building blocks. The production execution mode is the problem, not the
overall judging contract.

## 3. Important gaps and contradictions to resolve

### 3.1 The service currently has two pipelines

There is a legacy comparison pipeline:

```text
admin comparison
  → one Cloud Tasks job per case
  → standard Cosmic Guidance generation request
  → direct judge-provider completion call
  → per-job score
```

There is also a rebuilt artifact pipeline:

```text
materialize
  → render
  → judge
  → persisted v2 judgement
```

The OpenAI corpus scripts form a third, partially independent generation pipeline. They use
real provider batches, but only for a Cosmic Guidance/OpenAI-specific corpus.

The target must have one canonical lifecycle. Legacy tables and historical data can remain
read-only, but a new run must not silently choose between the legacy and rebuilt behavior.

### 3.2 Production LLM calls are not batch-only today

The following paths violate the requested rule:

- `server/services/generation-client.ts` calls the Cosmic Guidance generation endpoint for
  one case at a time.
- `server/workers/comparison-job-runner.ts` dispatches and executes one generation job per
  case through Cloud Tasks.
- `server/core/judge/runner.ts` expects a synchronous completion callback.
- `server/providers/*` implement direct provider completion calls for judging.
- `server/adapters/cosmic-guidance/judge.ts` loops through payloads and calls the provider
  per payload.
- `LOCAL_INLINE_WORKER=true` executes the same per-case provider path locally.

`run.yaml` says `execution.mode: batch`, but that is configuration intent rather than an
enforced runtime invariant. The target must reject any non-batch provider binding in a real
run. A standard/inline provider method must not exist on the production execution interface.

Cloud Tasks may still orchestrate **batch lifecycle work**—for example, submit, poll, import,
and finalize—but it must never be used to turn a batch run into one provider request per
case.

### 3.3 Provider support is not generic yet

The provider factory is swappable for judge completions, but the generation side is still
Cosmic Guidance-specific and the real batch implementation is OpenAI-specific. The universal
provider contract needs these operations:

```text
prepare(requests) → immutable batch input artifact
submit(input artifact) → provider batch ID
getStatus(provider batch ID) → lifecycle status and counts
downloadResults(provider batch ID) → output/error artifacts
cancel(provider batch ID) → cancellation result
```

Every supported provider must implement the same lifecycle. If a configured provider cannot
perform the required batch operation, the run fails before any LLM request is submitted. There
is no silent standard-call fallback.

### 3.4 The current comparison and rebuilt judge semantics differ

The legacy schema models a pairwise A/B judge with `dimensionScores`, `hardGateResults`, and
`pairwiseWinner`. The rebuilt v2 path judges each arm separately using universal and
track-specific metrics, and the current Cosmic Guidance dataset has no separate silver
reference. Both shapes exist in the database and report code.

The target canonical result is:

- one result per `(run, row, arm, judgeRole)`;
- universal metrics and applicable application metrics;
- hard-gate verdicts and evidence;
- optional comparative/silver metrics only when a reference is present;
- no pairwise winner unless a pairwise metric is explicitly configured;
- aggregate paired deltas computed by the statistics stage.

Pairwise A/B data already stored in legacy tables is historical. It should be decoded for old
reports but must not be mixed with v2 metric rows in a new statistical result.

### 3.5 “Two models” needs one explicit configuration meaning

The service currently has:

- a baseline/candidate model concept for generation;
- a primary judge model;
- a sampled secondary judge model;
- old model-family independence rules.

The new run configuration must name these independently:

```yaml
generationArms:
  - armId: champion
    provider: openai
    model: <confirmed model id>
  - armId: challenger-1
    provider: <provider>
    model: <model id>

judges:
  primary:
    provider: <provider>
    model: <model id>
    batch: true
  secondary:
    provider: <different provider family>
    model: <model id>
    batch: true
    sampleRate: 0.10
```

The **universal kernel plus application rubric** is one composed prompt sent to each judge.
If the product requirement is that both judge models score every row, set `sampleRate: 1.0`.
The existing 10–20% secondary sample is a cost/reliability default, not a hard limitation.

### 3.6 “Universal” is not yet enforced strongly enough

The intended architecture says `core/` must not know product vocabulary, but product-specific
logic still leaks through adjacent universal services:

- `server/services/deterministic-checks.ts` imports
  `adapters/cosmic-guidance/track-checks.ts` directly.
- `shared/contract.ts` hardcodes Cosmic Guidance-style track names and a Cosmic Guidance
  endpoint shape.
- `server/adapters/cosmic-guidance/materialize.ts` owns the run entrypoint and config paths.
- Batch scripts encode Cosmic Guidance calculation and reading construction.

The fix is a strict adapter port, not more `if (track === ...)` branches in the core.

### 3.7 Dataset/reference policy is not aligned with the original plan

The LLM plan defines silver as a reference axis and explicitly says silver is not truth. The
current blocker policy intentionally disables a separate silver reference and
`includeSilverAsBlindArm` is false. Both are valid modes, but they must be named as modes:

1. **Absolute evaluation mode:** universal + application metrics; no silver metrics.
2. **Reference-comparison mode:** the same metrics plus the optional silver-comparison axis.

No report may describe absolute evaluation as silver comparison, and no missing reference may
be silently treated as a blank or perfect reference.

### 3.8 Data coverage and model identity are not ready for a paid conclusion

The current config still has open blockers for:

- confirmation of the champion model ID/family;
- reconciliation of the imported production batch corpus;
- final verification of the zodiac generation route.

The current `datasets.yaml` marks the corpus unconfirmed and `models.yaml` contains TODO
judge/challenger values. The engine must continue to produce `NO RECOMMENDATION` or a blocked
run for these states. A complete-looking report with unresolved provenance is worse than a
failed run.

### 3.9 Cost is partly implemented but not yet one authoritative ledger

Pricing snapshots and request-attempt telemetry exist, but the final design must make every
billable event comparable:

- source generation request;
- primary judge request;
- secondary judge request;
- invalid-output retry;
- failed batch line with usage;
- batch-level provider usage;
- cache read/write tokens where published;
- provider-reported cost versus snapshot-calculated cost.

The current direct judge path and batch import path do not have one shared event model. The
cost stage must sum only canonical successful/failed attempt events and must not double-count
the same request from both a batch total and a per-line result.

## 4. Target architecture

### 4.1 Dependency direction

```text
                     ┌─────────────────────────────────────┐
                     │ Universal core                       │
                     │ run lifecycle · batch orchestration  │
                     │ blinding · prompts · evidence        │
                     │ metrics · stats · cost · reports      │
                     └──────────────────▲──────────────────┘
                                        │ ports only
                     ┌──────────────────┴──────────────────┐
                     │ Application adapters                │
                     │ Cosmic Guidance · future apps       │
                     │ source data · calculators · renderers│
                     │ strata · rubrics · pre-checks        │
                     └─────────────────────────────────────┘

                     ┌─────────────────────────────────────┐
                     │ Provider batch adapters              │
                     │ OpenAI · Anthropic · Gemini · mock   │
                     └─────────────────────────────────────┘
```

The universal core may depend on provider ports and application ports. It must never import
an application adapter. Provider adapters must know API mechanics only; they must not know
reading names or scoring rules.

### 4.2 Minimal universal ports

```ts
interface ApplicationAdapter {
  key: string;
  listDatasetSubjects(input: DatasetRequest): Promise<SubjectRef[]>;
  materializeCases(input: MaterializeRequest): Promise<MaterializedCase[]>;
  render(row: EvaluationRow): RenderedContent;
  precheck(row: EvaluationRow): PrecheckResult[];
  getRubric(track: string): RubricPack;
}

interface BatchProvider {
  prepare(requests: readonly BatchRequest[]): Promise<PreparedBatch>;
  submit(batch: PreparedBatch): Promise<SubmittedBatch>;
  status(batch: SubmittedBatch): Promise<BatchStatus>;
  results(batch: SubmittedBatch): Promise<BatchResults>;
  cancel(batch: SubmittedBatch): Promise<void>;
}
```

The exact TypeScript types can be narrower, but these responsibilities must exist. The source
application adapter may call its own internal preparation/calculation boundary, but the core
must not reconstruct application prompts or calculations.

### 4.3 Canonical run and artifact identity

Every run is immutable after submission except lifecycle status and operational timestamps.
The run manifest must pin:

- application adapter and adapter version;
- dataset version and checksum;
- selected subjects/cases/tracks;
- generation arms and opaque arm references;
- primary/secondary judge provider/model configuration;
- batch mode and provider batch IDs;
- universal kernel hash;
- application rubric hashes;
- output schema hashes;
- deterministic-check version;
- pricing snapshot ID and currency;
- statistics seed and iteration count;
- code/build/Git SHA;
- all open provenance blockers at run creation.

Recommended artifact tree:

```text
runs/<runId>/
  manifest.json
  source/
    cases.jsonl
    generation-requests/<provider>/<batch>.jsonl
    generation-results/<provider>/<batch>.jsonl
  evaluation/
    rows.jsonl
    payloads.blinded.jsonl
    prechecks.jsonl
    judge-requests/<judgeRole>/<provider>/<batch>.jsonl
    judge-results/<judgeRole>/<provider>/<batch>.jsonl
    invalid.jsonl
    retry-requests.jsonl
    scores.jsonl
  aggregates/
    metric-ledger.json
    cost.json
    stats.json
    decision-support.json
  audit/
    audit-slice.jsonl
    human-decisions.jsonl
  reports/
    report-01-decision-brief.md
    ...
```

The database stores indexes, statuses, hashes, usage, and searchable structured results. The
large immutable request/response artifacts live in the artifact store and are referenced by
content hash.

## 5. Canonical end-to-end flow

### Input gate — configuration and run creation

The operator selects:

- `applicationKey`, for example `cosmic_guidance`;
- dataset version and immutable source snapshot;
- users/subjects and tracks/readings;
- generation arms to create or import;
- primary and secondary judge models;
- absolute or reference-comparison mode;
- secondary judge sample rate;
- batch provider and completion window;
- metric/rubric version;
- pricing snapshot;
- run seed and concurrency/shard policy.

The service validates all of the following before accepting the run:

1. The application adapter exists and is compatible with the dataset.
2. Every selected track has a renderer, rubric, schema, and pre-check registration.
3. Every configured provider supports batch mode.
4. Models are identified by provider/model ID, not inferred from a string.
5. Judge models are independent from generation families according to the configured policy.
6. The dataset checksum and case selection are reproducible.
7. Pricing is available for all selected provider/model/usage-mode combinations, or the run
   is explicitly marked unpriced and cannot make a cost-based recommendation.
8. Open blockers are stamped into the manifest and any blocker marked as run-blocking stops
   the run.

No provider call occurs during validation or estimation.

### Stage 1 — Generate data by using the main source

This stage creates or imports the content to be evaluated. It has two supported paths with the
same output contract:

#### Path A: generate through the source application

1. The selected application adapter loads synthetic/de-identified subjects or an immutable
   source dataset.
2. It obtains deterministic calculations from the source application's calculator boundary.
3. It renders or asks the source application to prepare exact production-equivalent prompts.
4. It creates one batch request per `(run, case, generation arm)`.
5. The selected generation `BatchProvider.prepare()` writes an immutable JSONL/input artifact.
6. The provider batch is submitted and its provider batch ID is persisted.
7. A poller/coordinator records `submitted → in_progress → finalizing → completed/failed`.
8. Result and error files are downloaded, hashed, and imported by `customId`.
9. Every case receives a generation result, error status, usage record, or explicit missing
   result. Missing lines are not silently dropped.

#### Path B: import an existing source batch

1. The operator registers the source batch manifest, provider, model, prompt version, input
   checksum, output checksum, and completion evidence.
2. The service verifies the artifact and custom ID coverage.
3. It imports the same generation result shape as Path A.
4. The run manifest states that generation was imported rather than submitted by this run.

This is how the existing Cosmic Guidance batch corpus becomes a valid input without forcing
the universal core to know how it was produced.

#### Stage 1 outputs

Each materialized case must contain:

```json
{
  "caseId": "...",
  "subjectId": "opaque-subject-001",
  "applicationKey": "cosmic_guidance",
  "track": "numerology_detailed",
  "stratum": { "numberType": "life_path", "numberValue": 11 },
  "inputSnapshot": {},
  "arms": {
    "champion": { "output": {}, "schemaValid": true, "generationEventId": "..." },
    "challenger-1": { "output": {}, "schemaValid": true, "generationEventId": "..." }
  },
  "loadStatus": "ok"
}
```

The stage reports coverage by application, track, reading/depth, subject, stratum, arm,
provider, and batch. Any missing or malformed output becomes a defect/load status and is
excluded from LLM judging until resolved.

### Stage 2.1 — Materialize and pair

Materialization converts source outputs into the stable evaluation atom. Pair all generation
arms on the same subject, input snapshot, track, stratum, and case key. This pairing is needed
for fair deltas and cluster bootstrap.

Rules:

- `subjectId` is opaque and is the cluster key; never store a production user foreign key.
- `caseId` is stable for the dataset version.
- `armId` is opaque inside judge payloads.
- A reference/silver arm is optional and never treated as truth.
- Rows with missing required arms are recorded as incomplete; they are not paired by guessing.
- The sealed arm map is written once and cannot be overwritten with different contents.

### Stage 2.2 — Render and blind

The application renderer converts each row into:

```ts
{
  sections: [{ name, path, text }],
  fields: { "input.numberValue": 11, "input.numberType": "life_path" },
  text: "..."
}
```

The renderer must make every fact and section that can appear in evidence addressable. It may
remove unsafe/private transport material such as SVG or image data, but the sanitization rule
and resulting hash are recorded.

Blinding then:

1. maps real arms to `arm-0`, `arm-1`, etc.;
2. shuffles their order using the run seed/case ID;
3. removes provider, model, family, prompt, and arm labels from judge payloads;
4. writes the real mapping only to a sealed artifact unavailable to prompt, validation, and
   judging code;
5. tests payloads for leakage of every configured model/provider string.

The judge may receive `rowId` only as an internal envelope binding. It does not need a real
user or model identity.

### Stage 2.3 — Extract deterministic pre-checks

Pre-checks run before spending judge tokens. They are split into two categories:

#### Universal pre-checks

- input/output schema validity;
- required sections/fields;
- empty/truncated output;
- malformed JSON or encoding;
- safety and disallowed absolute claims;
- prompt-injection compliance markers;
- required evidence source availability;
- output/reference/input checksum and identity checks.

#### Application adapter pre-checks

The application adapter owns deterministic facts only it can know, such as a calculated
number, date, card, score, or domain-specific source value. It returns named, versioned checks;
the core only records and aggregates them.

Pre-check failures do not pretend to be LLM scores. They produce a defect record and can
short-circuit judging when the configured policy says the row is invalid. A valid row may still
have a deterministic failure that the judge must inspect, depending on the gate policy.

The defect record includes:

```text
runId, rowId, armId, checkName, checkVersion, passed, detail,
severity, sourceField, expected, observed, createdAt
```

### Stage 2.4 — Compose the judge request

The core builds one deterministic prompt from these layers, in order:

1. universal kernel;
2. universal metric definitions;
3. application/reading rubric pack;
4. optional comparative/silver metric block;
5. output contract and abstention rules;
6. rendered input data;
7. blinded reading arm(s);
8. optional blinded reference;
9. run-specific schema generated from the metric registry.

The prompt composer records SHA-256 hashes for each layer and the final prompt. Prompt text is
never assembled by the browser or by a product adapter at runtime without being hashed.

The output contract remains strict:

- every configured metric must appear;
- each metric is either a 1–5 score or a declared abstention;
- hard metrics emit gate status and violation where applicable;
- scores carry evidence;
- candidate/reference quotes must be verbatim substrings;
- input references must resolve to rendered fields and matching values;
- semantic absences are explicitly marked as judge findings and are eligible for human audit;
- invalid responses are rejected, never repaired into a valid score.

### Stage 2.5 — Submit LLM analysis batches

For each judge role:

1. create one batch request per valid blinded row/arm according to the selected judging mode;
2. persist the exact request artifact and request checksum;
3. submit through the configured provider's batch API;
4. persist provider batch ID and completion window;
5. poll until terminal state;
6. download output and error artifacts;
7. import by custom ID, preserving provider request IDs and usage.

The default analysis policy is:

```text
primary judge:   every valid row
secondary judge: deterministic sample, default 10%, configurable to 100%
```

If either judge is configured at 100%, it still runs as a separate batch and remains
independently identifiable in cost and reliability reports. The secondary judge must be a
different vendor/model family where the independence policy requires it.

There is no direct `complete()` production call. The mock provider may have an in-process
test implementation, but tests must exercise the same batch request/result envelope so the
real lifecycle is not hidden.

### Stage 2.6 — Validate evidence and isolate invalid results

The importer performs mechanical envelope/schema validation first. The evidence validator then
checks the full contract against the exact rendered payload.

For each invalid judge result:

1. persist the raw response and all validation issues;
2. create one isolated retry request containing only that row and the same pinned prompt;
3. submit the retry through a new provider batch;
4. accept it only if it passes the same validator;
5. after one failed retry, mark the row `invalid` and exclude it from quality aggregates;
6. include invalid rate and reasons in the report and cost ledger.

This implements the image's `retry once → isolate invalid` rule without allowing repeated
retries to hide a broken prompt or provider.

### Stage 2.7 — Write the metric ledger

The metric ledger is the normalized, queryable output of analysis. It contains one row per
metric result, not only an aggregate JSON blob:

```text
runId
rowId
subjectId
track
armId
judgeRole
metricKey
metricClass       factual | structural | quality | comparative
gateClass         hard | soft | none
score             nullable 1..5
abstainReason     nullable enum
gate              nullable pass | fail
evidence          structured JSON
judgeStatus       valid | invalid | abstained
promptHash
judgeBatchId
```

The ledger is the input to statistics, reports, human review, and quality/cost drill-down.
No browser-side interpretation of raw provider output is allowed.

### Stage 3.1 — Aggregate quality metrics

The implementation follows the LLM plan:

- universal soft metrics and `composite_quality` are comparable across applications;
- application/reading supplements are reported by track and do not silently enter the
  universal composite;
- hard gates are reported separately with failure counts, Wilson intervals, and evidence;
- conditional metrics abstain rather than score zero;
- abstentions are never imputed;
- reference-comparison metrics are absent, not zero, in absolute mode;
- the report shows score, denominator, abstention rate, evidence channel mix, and CI.

For a multi-arm run, calculate paired deltas against the configured champion/control. Never
rank an arm based only on similarity to silver or on a single blended quality-cost score.

### Stage 3.2 — Statistics and decision support

Use the planned paired cluster bootstrap:

- resample subjects/users, not independent rows;
- preserve all tracks/readings/arms for a sampled subject;
- retain duplicate subject draws;
- use the run seed and record bootstrap iterations;
- calculate paired deltas against the champion;
- report Wilson upper bounds for zero/near-zero gate failures;
- report judge noise, self-agreement, cross-judge agreement, and gate agreement;
- apply Benjamini–Hochberg only to the planned primary quality tests;
- refuse to pool rows with different prompt/rubric hashes.

The decision engine supplies decision support only:

1. eliminate arms with hard-gate or degeneracy upper bounds beyond configured tolerance;
2. identify quality-eligible arms within the declared quality margin;
3. choose the lowest-cost eligible arm only after quality/safety eligibility;
4. return `NO RECOMMENDATION` when evidence is insufficient or all arms are blocked;
5. mark borderline results for human review.

The engine never mutates production model routing.

### Stage 3.3 — Cost analysis

Cost must be computed from a canonical event ledger, with these dimensions:

```text
overall run
application
track / reading type / depth
subject/user cluster (opaque ID)
generation arm
judge role
provider
model
batch ID / request ID / attempt
success / failed / invalid-retry
usage mode: batch
```

For every event, persist:

- input/prompt tokens;
- output/completion tokens;
- total tokens;
- cache-read/cache-write tokens where supplied;
- reasoning/prediction tokens where supplied;
- provider-reported cost when trusted;
- snapshot-calculated cost otherwise;
- cost source and cost status;
- pricing snapshot ID;
- batch discount/usage mode;
- timestamps, latency if available, and provider request ID;
- error status without secrets or prompt content.

Cost precedence:

1. trusted provider-reported cost;
2. run pricing snapshot × recorded usage;
3. `unknown` if required usage/rate is absent.

`unknown` is not `$0`. A `partial` run reports observed cost and the missing/unknown portion.
Generation cost and judge cost are always separated, then rolled up by reading and overall.
Invalid retries are additional cost events; they are not hidden in the original request.

### Stage 3.4 — Reports and human decision

The target report bundle follows the LLM plan:

1. consolidated decision brief;
2. per-user/subject cost rollup;
3. per-track model comparison;
4. per-metric view;
5. evidence drill-down;
6. reliability and validity appendix;
7. sign-off sheet and decision log.

The component audits remain independent:

1. dataset;
2. prompt;
3. judge;
4. evidence;
5. metrics;
6. statistics;
7. cost;
8. gates.

Human actions are explicit:

```text
ACCEPT    accept the engine's recommendation
OVERRIDE  choose another arm and record why
DEFER     require another run, more data, or a rubric fix
```

Every gate firing, judge disagreement, invalid result, low-confidence result, substantive
reference disagreement, and borderline recommendation enters the audit slice according to
the configured policy. Human decisions are final and immutable except through a correction
record.

## 6. Data model changes

Reuse existing tables where their semantics match. Do not create a second parallel database
for the universal path. The existing legacy comparison tables remain historical/read-only when
their semantics do not match.

### 6.1 Tables to retain and repurpose carefully

| Existing table | Target use |
|---|---|
| `eval_datasets`, `eval_dataset_subjects`, `eval_dataset_cases` | Immutable dataset/case registry; add application key and stronger provenance if missing |
| `eval_generation_runs` | Provider batch lifecycle for source generation; enforce `execution_mode = batch` |
| `eval_prepared_requests` | Immutable source/judge batch request registry |
| `eval_generations` | Imported generation results and usage; add canonical event linkage if needed |
| `eval_judgements_v2` | Raw validated judge result per row/role; migrate toward generic arm semantics |
| `eval_llm_request_attempts` | Attempt-level telemetry and cost source; use for every batch request/result |
| `eval_pricing_snapshots`, `eval_pricing_rates` | Immutable historical pricing |
| `eval_run_manifests` | Pinned run configuration and artifact hashes |
| `eval_deterministic_results` | Pre-check results, once arm/application columns are complete |
| `eval_human_review_queue`, `eval_audit_log` | Human review and governance |

### 6.2 New or required fields

The minimum generic fields are:

- `application_key` and `adapter_version`;
- `run_id` on every source, judge, cost, and metric artifact;
- `case_id`, `subject_id`, `track`, `reading_key`, `stratum_key`;
- `arm_id` and sealed-map reference;
- `batch_id`, `custom_id`, `request_id`, `attempt`;
- `stage` (`source_generation`, `judge_analysis`, `invalid_retry`);
- `execution_mode` constrained to `batch` for production;
- `prompt_hash`, `schema_hash`, `rubric_hash`, `check_version`;
- `pricing_snapshot_id`, `usage_mode`, `cost_status`, `cost_source`;
- immutable input/output/request/response checksums;
- `load_status`, `judge_status`, and `precheck_status`.

### 6.3 Metric ledger table

Add a normalized metric-result table if querying JSON responses is insufficient:

```text
eval_metric_results
  id
  run_id
  row_id
  subject_id
  arm_id
  judge_role
  metric_key
  metric_class
  gate_class
  score
  abstain_reason
  gate
  violation
  evidence_json
  status
  prompt_hash
  created_at
```

This table is not a replacement for the raw response. It is the ledger used by statistics and
reports.

## 7. Cosmic Guidance as the first adapter

The current Cosmic Guidance work becomes `server/adapters/cosmic-guidance/` and must implement
the generic ports:

| Adapter responsibility | Existing source | Target action |
|---|---|---|
| Synthetic subject/input source | `AB Dataset.xlsx`, imported dataset, `datasource.ts` | Normalize into opaque subject/case records; remove unnecessary PII from persisted payloads |
| Deterministic calculator | `calc-snapshot` and existing CG calculators | Keep source-owned; store calculator version and output checksum |
| Source prompt preparation | `prepare-cg-batch-corpus.ts`, CG preparation endpoint | Move model/track/date constants into adapter config; return generic `BatchRequest`s |
| Source batch generation | OpenAI Batch scripts | Wrap in `BatchProvider`; retain artifacts and import logic |
| Track mapping | `track-map.ts`, `config/tracks/*.yaml` | Keep in adapter/config; core sees only stable track keys |
| Rendering | `renderer.ts` and track render logic | Keep; guarantee evidence-addressable fields/sections |
| Track checks | `track-checks.ts` | Expose through adapter pre-check port; remove direct import from universal service |
| Rubric packs | `docs/LLM PLAN/01-judge-prompt/rubric-packs/` | Keep as adapter-owned content referenced by track config |
| Coverage/blockers | `blockers.yaml`, dataset manifests | Stamp into run manifest and rows; block unsafe activation |

The first production acceptance target is not “all 17 tracks pass.” It is:

```text
Cosmic Guidance adapter → generic batch generation → generic judge batches
→ generic evidence/metrics/cost/reporting
```

Numerology can remain the first vertical slice, followed by Tarot/My Day, charts, static
scores, and zodiac as specified in the LLM plan. Unsupported or blocked tracks remain visible
as `NO RECOMMENDATION`; they do not fall back to the legacy standard path.

## 8. Future application adapter contract

Adding a new application must require only:

1. application adapter implementation;
2. application dataset export/import contract;
3. track/reading configuration;
4. application rubric packs;
5. application deterministic pre-checks;
6. provider/model and pricing configuration.

It must not require changes to:

- the universal kernel;
- evidence validation;
- batch lifecycle state machine;
- cost calculations;
- cluster bootstrap/statistics;
- dashboard aggregate APIs;
- human decision semantics.

A second adapter should be added as a boundary test. The test must prove that a non-Cosmic
Guidance adapter can run materialization, rendering, prompt composition, mock batch judging,
validation, cost aggregation, and report generation without importing Cosmic Guidance code.

## 9. Delivery phases and exit gates

### Phase 0 — Freeze the canonical contracts

**Work**

- decide whether the first run is absolute mode or reference-comparison mode;
- confirm the meaning and coverage of the two judge models;
- define generic `ApplicationAdapter` and `BatchProvider` ports;
- add `batch` as a runtime-enforced execution mode;
- define run/batch/request/metric/cost IDs and statuses;
- mark legacy standard-call paths read-only/deprecated;
- close or explicitly retain dataset/model blockers.

**Exit gate**

- a config with a standard-only provider cannot start;
- no production code path can call a provider synchronously;
- a run manifest can be created without application-specific branching in core.

### Phase 1 — Generic batch provider layer

**Work**

- implement prepare/submit/status/results/cancel for each supported provider;
- wrap OpenAI Batch first using existing scripts as fixtures/reference;
- implement Anthropic/Gemini only after their actual batch contracts are pinned;
- implement a mock batch provider with delayed lifecycle and output/error files;
- persist batch state transitions, custom IDs, checksums, and import manifests;
- add provider-level retry rules for submission/polling/import, separate from invalid-row retry.

**Exit gate**

- the same core test passes with mock and OpenAI-shaped batch fixtures;
- duplicate import is idempotent;
- missing, duplicate, unknown, and late custom IDs are detected;
- no standard completion API is used.

### Phase 2 — Generic Stage 1 source generation

**Work**

- move Cosmic Guidance preparation into its adapter;
- produce source generation batch requests for champion and challenger arms;
- import existing `cg-production-batch-only-20260828` as a verified artifact;
- store deterministic calculator provenance and output checksums;
- unify imported and newly generated output shapes;
- enforce coverage and `NO RECOMMENDATION` status.

**Exit gate**

- one Cosmic Guidance run produces a complete materialized case set from a batch;
- the same source output can be re-rendered without another provider call;
- generation cost reconciles from line usage and batch metadata;
- PII minimization and artifact access rules pass review.

### Phase 3 — Generic Stage 2 analysis batches

**Work**

- consolidate row materialization, pairing, rendering, blinding, and pre-checks;
- compose universal kernel + universal metrics + adapter rubric + output contract;
- submit primary and secondary judge batches;
- import structured results;
- implement one isolated invalid-output retry batch;
- persist evidence-gated metric ledger rows;
- migrate v2 judging away from the per-job standard path.

**Exit gate**

- every valid row is either validly scored, validly abstained, or explicitly invalid;
- no model/provider identity leaks into blinded payloads;
- quotes, input refs, absence scopes, gates, and abstentions are mechanically validated;
- primary/secondary analysis uses the same prompt hashes and run manifest.

### Phase 4 — Metrics, statistics, and cost

**Work**

- implement universal and track metric registry from `config/metrics.yaml`;
- implement normalized metric ledger aggregation;
- implement paired cluster bootstrap and Wilson intervals;
- implement judge reliability/noise calculations;
- implement full canonical cost event ledger and per-reading/overall rollups;
- remove unresolved rate assumptions from paid-run eligibility;
- implement estimate-versus-actual variance.

**Exit gate**

- known-effect bootstrap fixture recovers its effect;
- zero-failure gates show Wilson upper bounds;
- all cost totals reconcile to attempt events;
- unknown prices/usages remain unknown and block cost-based recommendations;
- source generation and judge analysis totals are separately visible.

### Phase 5 — Reports, audit, and human decision

**Work**

- implement the seven reports and eight audits;
- add evidence drill-down by reading, arm, user/subject, metric, and batch;
- add audit sampling and every-gate-failure review;
- add accept/override/defer decision API and immutable decision log;
- make final reports fail closed on unresolved audit blockers.

**Exit gate**

- a human can reconstruct any recommendation from manifest → payload → response → evidence →
  metric → statistic → decision;
- human decision is the only final decision state;
- no report presents the engine as truth or production authority.

### Phase 6 — Adapter boundary and application onboarding

**Work**

- add a tiny non-Cosmic fixture adapter;
- run the entire pipeline using only the fixture adapter;
- remove all universal imports of Cosmic Guidance modules and vocabulary;
- add application registration/config validation;
- document the adapter onboarding checklist.

**Exit gate**

- the second adapter runs without core changes;
- dependency-direction and vocabulary tests pass;
- application-specific rubrics/checks remain outside core.

### Phase 7 — Retire the legacy runtime path

Only after the new pipeline passes the full gates:

- stop creating new jobs through the per-case standard generation path;
- stop direct provider completion calls in production;
- keep legacy tables and historical reports read-only;
- remove or quarantine `LOCAL_INLINE_WORKER` for real providers;
- update README/API/dashboard language to say batch-only;
- require new runs to use the universal run manifest and artifact tree.

Do not add a long-lived dual-write or track-by-track fallback. A track that is not ready is
blocked or reported `NO RECOMMENDATION`.

## 10. Testing and verification matrix

### Contract and boundary tests

- core imports no application adapter;
- core contains no application/domain vocabulary outside fixtures;
- a second fixture adapter can execute the core;
- every track has a renderer, rubric, metric assignment, and schema;
- universal metric/register counts reconcile with the documentation.

### Batch lifecycle tests

- prepare artifact is deterministic;
- submission is idempotent;
- provider status transitions are persisted;
- polling resumes after process restart;
- duplicate output lines are rejected;
- missing output/error lines are detected;
- unknown custom IDs are quarantined;
- failed line can be retried in an isolated batch;
- provider usage and batch totals do not double-count;
- cancellation does not erase completed usage.

### Judge/evidence tests

- model/provider names never appear in blinded payloads;
- invalid schema is rejected;
- paraphrased quote is rejected;
- invalid input field/value is rejected;
- present section cannot be declared missing;
- empty-evidence score is rejected;
- conditional metric abstention is accepted;
- hard-gate failure requires a concrete violation;
- one invalid retry is attempted, then the row is isolated.

### Statistics/cost tests

- paired cluster bootstrap preserves all rows for sampled subjects;
- known injected effect is recovered;
- same seed reproduces intervals;
- Wilson upper bound is non-zero for zero failures;
- abstentions are not imputed;
- prompt-hash mismatch blocks pooling;
- generation and judge cost reconcile to event ledger;
- unknown price never becomes zero;
- batch discount/usage mode is reflected in cost;
- estimate-versus-actual variance is reported.

### E2E gates

1. mock source batch → imported generation rows;
2. mock primary/secondary judge batches → validated scores;
3. deterministic pre-check failure → defect/audit path;
4. invalid judge output → isolated retry → invalid quarantine;
5. missing batch line → incomplete run/no recommendation;
6. gate failure → evidence drill-down and human review;
7. cost reconciliation → reading and overall rollups;
8. accepted/overridden/deferred human decision → immutable audit record;
9. Cosmic Guidance adapter → same generic flow;
10. second fixture adapter → same generic flow without core changes.

## 11. Definition of done

The universal judge service is complete when all of the following are true:

- every production LLM call made by the service is a provider batch call;
- the source application owns source prompts/calculations and the Judge owns evaluation;
- the universal kernel is reused unchanged across applications unless intentionally versioned;
- application-specific reading rubrics and checks are adapter-owned;
- primary and secondary judge models are independently configured and costed;
- generation arms, judge models, and prompt layers are not conflated;
- every score is evidence-grounded or explicitly abstained/invalid;
- every batch request/result/attempt has a reproducible artifact and checksum;
- costs are visible overall, per application, per reading, per subject, per arm, per judge, and
  per model;
- missing usage/prices are visible as unknown/partial, never zero;
- statistics preserve pairing and clustering and expose judge noise;
- recommendations are withheld when gates, coverage, evidence, or audits fail;
- humans accept, override, or defer and their decision is final;
- adding a second application requires an adapter/config/rubric, not core engine changes.

## 12. Immediate next actions

1. Confirm whether the first target run is absolute mode or reference-comparison mode.
2. Confirm whether the secondary judge scores a sample or every row; set the config explicitly.
3. Close the champion-model, corpus-reconciliation, and zodiac-route blockers or leave the run
   blocked with visible reasons.
4. Introduce the generic `BatchProvider` contract and make `execution.mode: batch` enforced.
5. Freeze the legacy standard comparison path from creating new production runs.
6. Wrap the existing OpenAI batch scripts behind the generic source batch provider interface.
7. Build the mock batch E2E vertical slice before adding another real provider.
8. Migrate one Cosmic Guidance track—numerology is the planned first slice—through the full
   source batch → judge batch → evidence → metrics → cost → report flow.
9. Add a second fixture adapter before declaring the core universal.
10. Only then expand to the remaining Cosmic Guidance tracks and paid full sweeps.

