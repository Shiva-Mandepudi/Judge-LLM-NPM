# Universal LLM Judge — Complete E2E Implementation Plan

**Status:** Approved architecture; implementation plan

**Canonical document:** judge-service/docs/universal-llm-judge-e2e-plan.md

**Scope:** the universal internal evaluation engine, provider batch integrations, application
adapters, Cosmic Guidance integration, metrics, statistics, cost accounting, reports, audit,
and human decision workflow.

**First application:** Cosmic Guidance.

**Future applications:** any application, regardless of programming language, database,
deployment model, or source-data format.

**Execution rule:** every production LLM request made by this system is submitted through a
provider batch API. There is no synchronous provider fallback.

**Final authority:** the engine recommends; a human accepts, overrides, or defers.

> A silver reference is a high-quality reference, not truth. Similarity to silver is a
> separate diagnostic axis and is never the objective function.

## 1. Executive decision

The service will be rewritten as a product-neutral, local-first Python evaluation platform
using Neon PostgreSQL as its durable operational database.

### 1.1 Approved stack

| Layer | Decision |
|---|---|
| Runtime | Python 3.13, pinned in the project lockfile |
| Environment and dependencies | uv and pyproject.toml |
| Local API and dashboard server | FastAPI, bound to localhost |
| CLI and worker commands | Typer |
| Contracts and validation | Pydantic v2 and JSON Schema |
| Database | Neon PostgreSQL |
| Database driver | Psycopg 3 |
| Database access | SQLAlchemy 2 |
| Migrations | Alembic |
| Provider integrations | official OpenAI, Anthropic, and Google Gemini SDKs behind a local port |
| Tabular analysis | Polars |
| Numerical/statistical analysis | NumPy and SciPy |
| Reports | Markdown, JSON, and optional HTML |
| Artifacts | local encrypted content-addressed filesystem; metadata in Neon |
| Logging | Python standard logging as JSON Lines plus database run events |
| Tests | Pytest, Ruff, and type checking |
| Deployment | local process or optional local Docker image; no public service |

The stack deliberately does not introduce Redis, Celery, Kafka, Airflow, Prefect, Dagster,
LangChain, LlamaIndex, Kubernetes, or a second operational database.

### 1.2 The three business stages

~~~text
Stage 1 — Generate or import source data
    source application adapter + source batch generation

Stage 2 — LLM analysis
    universal kernel + application rubric + primary/secondary judge batch jobs

Stage 3 — Cost and decision analysis
    metric ledger + statistics + cost ledger + reports + human audit
~~~

The image's eleven operational gates map to the implementation as follows:

~~~text
Inputs
  → 1 Materialize and pair
  → 2 Render and blind
  → 3 Mechanical pre-checks
  → 4 Compose judge request
  → 5 Submit and complete LLM batches
  → 6 Validate evidence
  → 7 Write metric ledger
  → 8 Calculate cost
  → 9 Calculate statistics
  → 10 Produce decision support
  → 11 Human audit and decision
~~~

### 1.3 Non-negotiable invariants

1. The source application may use any technology stack.
2. The source application owns domain calculations and source-specific generation.
3. The judge owns evaluation, evidence, metrics, statistics, cost, reports, and audit.
4. The universal core never imports an application adapter.
5. Provider calls in a real run are batch calls only.
6. Source data, prompts, outputs, and results are versioned and hashable.
7. Model names are hidden from judge payloads through sealed arm mapping.
8. A score without valid evidence is rejected.
9. Abstentions are never converted to zero, midpoint, or an imputed score.
10. Hard gates are not averaged into quality.
11. Unknown cost is never represented as zero.
12. Statistics resample the user/subject cluster, not independent rows.
13. Prompt, rubric, schema, dataset, code, pricing, and statistics versions are pinned.
14. The system produces a recommendation only when configured evidence gates allow it.
15. A human decision is the final decision and is permanently recorded.

## 2. Universal scope and ownership

### 2.1 The engine is application-neutral

The engine evaluates generated content from any application. It can judge readings, documents,
support answers, recommendations, summaries, or other generated content as long as an adapter
produces the canonical input and output shapes.

Cosmic Guidance is the first adapter. It is not the definition of the engine.

### 2.2 Any source-application stack is supported

The source application may be written in Node.js, Python, Java, Go, .NET, PHP, or another
technology. It may use PostgreSQL, MySQL, MongoDB, files, or another source system.

The judge does not import source code or source database schema. The adapter connects through a
versioned boundary such as:

- JSONL or CSV export;
- REST or GraphQL API;
- database read/export;
- local CLI;
- shared filesystem handoff;
- another source batch system.

The source boundary must provide stable IDs, immutable dataset/version, source calculation
version, input hashes, output hashes, and enough metadata to reproduce the batch.

### 2.3 Source-application responsibilities

The source application owns:

- source inputs and domain calculations;
- trusted fact tables and reference values;
- source-specific generation prompts;
- source output schema;
- candidate/champion generation;
- source-provider batch submission when generation uses an LLM;
- source output and usage export.

The source application may synchronously perform deterministic calculations. It may not cause
the judge to make a synchronous LLM call. Any LLM provider call in source generation must
also use a batch process.

### 2.4 Judge-service responsibilities

The judge owns:

- run creation and immutable manifests;
- source batch import and verification;
- materialization and pairing;
- rendering and blinding;
- mechanical integrity pre-checks;
- universal prompt and rubric composition;
- provider batch submission, polling, and import;
- structured-output and evidence validation;
- metric normalization;
- quality, safety, usefulness, and comparative analysis;
- statistical confidence and model comparison;
- generation and judge cost accounting;
- reports, audit sampling, and human decisions.

### 2.5 Silver is not truth

The silver reference is frontier-model-generated and human-reviewed. It is a useful second
opinion, not an answer key. A challenger may be better than silver.

Silver is used for:

- a separate semantic comparison axis;
- calibration;
- human-review target selection;
- a blind-arm quality benchmark when configured.

Silver is never silently treated as ground truth, included in composite_quality, required in
absolute evaluation mode, or used as a minimum similarity target.

### 2.6 The two judge models

Generation models and judge models are independent concepts.

~~~yaml
generation_arms:
  - arm_id: champion
    provider: ...
    model: ...
  - arm_id: challenger_1
    provider: ...
    model: ...

judges:
  primary:
    provider: ...
    model: ...
    sample_rate: 1.0
  secondary:
    provider: ...
    model: ...
    sample_rate: 0.10
~~~

The universal kernel and application rubric are two prompt layers inside one judge request;
they are not two LLM calls. Primary and secondary judge models are independent analysis models.
The secondary sample rate is configurable and can be 1.0.

The judge family must be independent from generation families where policy requires it. The exact
champion family must be confirmed before selecting the primary judge.

## 3. Rewrite decisions

The current judge-service contains valuable domain and evaluation work, but its runtime is not
the target architecture.

### 3.1 Preserve and port

Preserve as specification, fixtures, or domain input:

- universal kernel and output contract;
- application rubric packs;
- universal, track, and silver metric definitions;
- evidence validation rules;
- stable row IDs and sealed model mapping;
- dataset and blocker concepts;
- pricing snapshots and usage records;
- cluster bootstrap/statistical design;
- seven decision reports and eight component audits;
- existing batch JSONL examples and provider result fixtures;
- Cosmic Guidance renderers and deterministic calculators after adapter isolation.

### 3.2 Remove from the new production path

Remove:

- Node 20 runtime;
- Express as core runtime;
- Drizzle as database layer;
- Cloud Run as a requirement;
- Cloud Tasks per-case execution;
- direct provider completion methods;
- LOCAL_INLINE_WORKER for real providers;
- one-provider-request-per-case orchestration;
- Cosmic Guidance imports inside universal core code.

Historical tables and reports may remain read-only. They must not be silently mixed with new
canonical metric rows unless run manifest, prompt hashes, schema, arm semantics, and execution
mode match.

## 4. Approved technical architecture

### 4.1 Local process roles

~~~text
judge serve
  localhost API + dashboard + run/report queries

judge run ...
  short-lived CLI commands for creating and advancing stages

judge worker --run-id <id>
  resumable coordinator for source and judge batch submission, polling, and import
~~~

There is no distributed queue in the first version. The database state machine makes work
resumable. The API creates runs or exposes status; the worker performs long operations.

### 4.2 Dependency direction

~~~text
                    ┌──────────────────────────────────┐
                    │ Universal core                   │
                    │ runs · batches · prompts         │
                    │ evidence · metrics · stats       │
                    │ cost · reports · audits          │
                    └───────────────▲──────────────────┘
                                    │ ports only
              ┌─────────────────────┴──────────────────────┐
              │ Application adapters                         │
              │ Cosmic Guidance · future applications       │
              │ source data · renderers · checks · rubrics   │
              └─────────────────────────────────────────────┘

              ┌─────────────────────────────────────────────┐
              │ Provider batch adapters                      │
              │ OpenAI · Anthropic · Gemini · mock           │
              └─────────────────────────────────────────────┘
~~~

The core may depend on ports but must never import an adapter. Provider adapters know API
mechanics only; they do not know reading names, application facts, or scoring rules.

Boundary checks must fail if core code imports adapter modules or contains application
vocabulary such as natal, tarot, numerology, zodiac, or my_day outside fixtures.

### 4.3 Repository layout

~~~text
judge-service/
├── pyproject.toml
├── uv.lock
├── src/judge_service/
│   ├── cli.py
│   ├── api/
│   ├── core/
│   │   ├── contracts/
│   │   ├── runs/
│   │   ├── batches/
│   │   ├── prompts/
│   │   ├── blinding/
│   │   ├── evidence/
│   │   ├── metrics/
│   │   ├── statistics/
│   │   ├── costs/
│   │   ├── reports/
│   │   └── audit/
│   ├── db/
│   │   ├── models.py
│   │   ├── repositories.py
│   │   └── session.py
│   ├── providers/
│   │   ├── base.py
│   │   ├── openai_batch.py
│   │   ├── anthropic_batch.py
│   │   ├── gemini_batch.py
│   │   └── mock_batch.py
│   └── adapters/
│       ├── registry.py
│       ├── cosmic_guidance/
│       └── fixture_application/
├── alembic/
├── config/
│   ├── applications/
│   ├── tracks/
│   ├── metrics.yaml
│   ├── thresholds.yaml
│   ├── models.yaml
│   ├── pricing.yaml
│   └── run.yaml
├── prompts/
│   ├── universal/kernel.md
│   ├── universal/metrics.md
│   ├── universal/comparative.md
│   └── applications/<application>/rubric-packs/
├── artifacts/
├── reports/
├── admin-dashboard/
├── tests/
└── docs/
~~~

The existing docs/LLM PLAN remains the detailed prompt and metric specification. This
document is the implementation source of truth for the rewritten runtime.

### 4.4 Neon connection policy

Use:

~~~text
JUDGE_DATABASE_URL_POOLER   application/API/worker connection
JUDGE_DATABASE_URL_DIRECT   migrations and administrative operations
~~~

Use TLS, least-privilege roles, small application pool sizes, and explicit query timeouts.
Use Neon branches for development, migration testing, integration tests, and destructive-query
testing. Do not create one branch per evaluation run.

## 5. Universal contracts

### 5.1 ApplicationAdapter

~~~python
class ApplicationAdapter(Protocol):
    key: str
    version: str

    def validate_dataset(self, request: DatasetRequest) -> DatasetValidation: ...
    def import_source_batch(self, request: SourceImportRequest) -> SourceImport: ...
    def prepare_generation(self, request: GenerationRequest) -> list[BatchRequest]: ...
    def materialize_cases(self, request: MaterializeRequest) -> list[EvaluationCase]: ...
    def render_input(self, case: EvaluationCase) -> RenderedContent: ...
    def render_candidate(self, case: EvaluationCase, arm_id: str) -> RenderedContent: ...
    def run_prechecks(self, case: EvaluationCase) -> list[PrecheckResult]: ...
    def tracks(self) -> list[TrackSpec]: ...
~~~

An adapter may use any transport internally. The core sees only canonical objects.

### 5.2 BatchProvider

~~~python
class BatchProvider(Protocol):
    provider_key: str

    def prepare(self, requests: list[BatchRequest]) -> PreparedBatch: ...
    def submit(self, prepared: PreparedBatch) -> SubmittedBatch: ...
    def get_status(self, submitted: SubmittedBatch) -> BatchStatus: ...
    def download_results(self, submitted: SubmittedBatch) -> DownloadedResults: ...
    def cancel(self, submitted: SubmittedBatch) -> CancelledBatch: ...
    def normalize_result(self, item: ProviderResult) -> NormalizedResult: ...
    def normalize_usage(self, item: ProviderResult) -> UsageRecord: ...
~~~

The production interface has no complete, chat, or generate-one method. The mock provider
follows the same batch envelope and lifecycle.

### 5.3 RenderedContent

~~~json
{
  "sections": [
    {"name": "Overview", "path": "sections.overview", "text": "..."}
  ],
  "fields": {
    "input.numberValue": 11,
    "input.numberType": "life_path"
  },
  "text": "complete rendered content",
  "content_hash": "sha256:..."
}
~~~

fields makes input references resolvable and sections makes missing-section evidence exact.
Adapters may remove unsafe transport material such as raw SVG when it is not part of evaluation,
but must record the sanitization rule and resulting hash.

### 5.4 Canonical evaluation row

~~~json
{
  "row_id": "sha256(run|case|track|stratum|arm)",
  "run_id": "run_...",
  "case_id": "case_...",
  "subject_id": "opaque_subject_...",
  "application_key": "cosmic_guidance",
  "track": "numerology_detailed",
  "stratum": {"numberType": "life_path", "numberValue": 11},
  "input_snapshot": {},
  "arm_id": "arm-1",
  "candidate_output": {},
  "reference_output": null,
  "load_status": "ok"
}
~~~

subject_id is opaque and is the statistical cluster key. It must not be a production user
foreign key. case_id is stable for the dataset version. Missing, malformed, or mismatched
arms are recorded as load defects and never paired by guessing.

### 5.5 Prompt layers

The final judge request is composed in this order:

1. universal judge kernel;
2. universal metric block;
3. application/reading rubric pack;
4. optional comparative/silver metric block;
5. output contract and abstention rules;
6. rendered input data;
7. blinded candidate arm or arms;
8. optional blinded silver reference;
9. run-specific structured-output schema.

The composer records every layer hash and final payload hash. Prompt text is never assembled
by the browser or silently changed by an adapter.

### 5.6 Judge output contract

Every response is structured JSON:

~~~json
{
  "rowId": "...",
  "metrics": {
    "metric_key": {
      "score": 1,
      "abstainReason": null,
      "evidence": {
        "candidateQuotes": [],
        "referenceQuotes": [],
        "inputRefs": [],
        "absences": [],
        "rationale": "..."
      },
      "gate": "pass",
      "violation": null
    }
  },
  "overall": {
    "summary": "...",
    "confidence": "low",
    "confidenceReason": "...",
    "silverComparison": null
  }
}
~~~

Rules:

- score is an integer from 1 to 5 or null;
- abstention uses exactly one allowed reason;
- abstention never carries score evidence;
- hard metrics require gate; failed gate requires violation;
- every score requires candidate quote, reference quote, input reference, or absence;
- candidate/reference quotes must be verbatim substrings;
- input references must resolve to rendered fields and matching values;
- semantic absence claims are flagged for human audit;
- metric keys must exactly equal configured track rubric keys;
- invalid output is rejected, never repaired;
- overall.summary is diagnostic and never aggregated.

Allowed abstention reasons:

~~~text
no_evidence_in_output
input_insufficient
metric_not_applicable
output_unintelligible
~~~

Evidence limits default to four candidate quotes, four reference quotes, six input
references, six absences, and bounded rationale/violation lengths.

## 6. Run configuration and identity

### 6.1 Required configuration

~~~yaml
run_id: 2026-09-11-sweep-01
application_key: cosmic_guidance
adapter_version: 1.0.0
dataset:
  key: ab-evaluation
  version: v1
  checksum: sha256:...
  subject_selection: ...
tracks:
  - numerology_brief
  - numerology_detailed
generation_arms:
  - arm_id: champion
    provider: openai
    model: exact-model-id
    source_mode: generate_batch
  - arm_id: challenger_1
    provider: anthropic
    model: exact-model-id
    source_mode: import_batch
judges:
  primary:
    provider: gemini
    model: exact-model-id
    sample_rate: 1.0
  secondary:
    provider: anthropic
    model: exact-model-id
    sample_rate: 0.10
evaluation_mode: absolute
silver:
  enabled: false
  include_as_blind_arm: false
statistics:
  seed: 20260911
  bootstrap_iterations: 10000
  confidence_level: 0.95
pricing_snapshot_id: pricing-2026-09-11
execution:
  mode: batch
  resume: true
  shard_by: track
  max_concurrent_shards: 4
~~~

### 6.2 Validation before any provider call

Confirm:

1. adapter exists and is compatible with dataset;
2. every track has renderer, rubric, schema, and metric registration;
3. every provider supports required batch operation;
4. every model is an exact provider/model ID;
5. judge independence rules pass or have a human override;
6. dataset checksum and selection are reproducible;
7. pricing exists for every model and usage mode, or run is explicitly unpriced;
8. no run-blocking dataset/model/route blocker is unresolved;
9. prompts and schemas load and hash;
10. privacy classification and retention policy are present;
11. execution mode is batch;
12. run ID is unique and immutable.

No provider request occurs during validation or estimation.

### 6.3 Run manifest

Pin:

- application and adapter version;
- dataset and source snapshot checksums;
- subject, case, and track selection;
- generation arms and sealed mapping reference;
- primary and secondary judge configuration;
- evaluation mode and silver policy;
- kernel, universal metric, rubric, comparative, and schema hashes;
- deterministic-check version;
- pricing snapshot and currency;
- statistics seed, bootstrap count, and confidence level;
- code/build/Git identifier;
- privacy and artifact retention policy;
- blockers at run creation;
- every batch artifact hash and provider ID.

Runs are append-only except for status, timestamps, and operational metadata. A changed
evaluation decision creates a new decision record.

### 6.4 Prerequisites and blockers

These prerequisites are checked before the phase that needs them. They are not hidden
assumptions:

| ID | Prerequisite | Blocks |
|---|---|---|
| P1 | Source/reference and candidate datasets exist with per-track output columns, stable subject/case keys, and the adapter contract reconciled against the real source schema | source and evaluation integration |
| P2 | Champion exact provider/model ID is confirmed; the current human label is not sufficient | model configuration and cost |
| P3 | Champion and silver-generator model families are confirmed so judge independence can be checked | judge selection and calibration |
| P4 | Pricing rates exist for every generation and judge model, including batch usage and cache fields where applicable | paid comparison and cost recommendation |
| P5 | Every selected source track is reachable through the source application's configured route; a hardcoded provider bypass is not accepted | source generation for that track |
| P6 | Synthetic or de-identified subjects are used by default; real birth dates, times, places, names, and other identifiers require an explicit privacy decision | all real-data runs |

A blocker may be informational or run-blocking. Every blocker is written into the run
manifest. A run with a run-blocking blocker cannot submit a provider batch.

## 7. Complete end-to-end flow

### Stage 0 — Input gate and run creation

The operator creates a run through CLI or local API. The service validates it, creates the
manifest and initial stage, and records an event.

Outputs:

- run ID;
- immutable manifest;
- adapter and configuration hashes;
- status created;
- no provider calls.

### Stage 1 — Generate or import source data

#### Path A: generate through source adapter

1. Load synthetic or de-identified subjects.
2. Obtain deterministic source calculations.
3. Create production-equivalent source generation requests.
4. Create one batch request per run, case, and generation arm.
5. Write and hash provider input artifact.
6. Submit through source BatchProvider.
7. Persist provider batch ID before polling.
8. Poll and persist lifecycle transitions.
9. Download and hash output/error artifacts.
10. Import every line by deterministic custom ID.
11. Record usage, cost event, errors, and missing lines.

#### Path B: import an existing source batch

1. Register provider, model, prompt/source versions, input hash, output hash, and completion
   evidence.
2. Verify custom-ID coverage and artifact integrity.
3. Normalize into the same source result contract.
4. Mark generation mode imported in manifest.

#### Stage 1 output

~~~json
{
  "case_id": "case_001",
  "subject_id": "opaque_subject_001",
  "application_key": "cosmic_guidance",
  "track": "numerology_detailed",
  "stratum": {"numberType": "life_path", "numberValue": 11},
  "input_snapshot": {},
  "arms": {
    "champion": {
      "output": {},
      "schema_valid": true,
      "generation_event_id": "usage_..."
    },
    "challenger_1": {
      "output": {},
      "schema_valid": true,
      "generation_event_id": "usage_..."
    }
  },
  "load_status": "ok"
}
~~~

Missing or malformed outputs become explicit load statuses such as missing_candidate,
missing_reference, unparseable, or input_mismatch. They are reported and excluded from
judging until resolved.

### Stage 2.1 — Materialize and pair

Pair arms using:

~~~text
subject_id + case_id + track + stratum_key + input_snapshot_hash
~~~

Rules:

- same input snapshot for every arm;
- stable row ID from run and case identity;
- opaque subject IDs only;
- no pairing by row order;
- missing arms recorded as incomplete;
- silver/reference optional;
- sealed arm map created once and never overwritten.

### Stage 2.2 — Render and blind

The adapter renders input and outputs into RenderedContent. The core then:

1. maps real arms to opaque arm-0, arm-1, and so on;
2. shuffles order using run seed and row ID;
3. removes model, provider, family, prompt, and arm labels;
4. stores real mapping in a sealed artifact inaccessible to prompt, judge, and validation;
5. scans payloads for configured model/provider strings;
6. stores blinded payload hashes.

The judge sees no production user ID and no model identity.

### Stage 2.3 — Mechanical pre-checks

Pre-checks are integrity checks, not replacement quality scores.

Universal checks:

- input/output encoding and parseability;
- source and output schema shape;
- required rendered sections and fields;
- empty, placeholder, truncated, or malformed output;
- stable input snapshot identity across arms;
- artifact checksum consistency;
- prompt-injection boundary markers;
- required evidence field availability;
- privacy/PII policy violations;
- duplicate case/arm detection.

Adapter checks may verify:

- calculated number or score;
- target date;
- drawn card and orientation;
- chart or transit identity;
- trusted reference field presence.

Every check has name, version, expected value, observed value, severity, and source field.

The following remain LLM-judged for valid rows: input_grounding, safety_compliance,
structural_completeness, and all quality metrics. An unparseable row cannot enter a payload.
A known adapter defect may be passed as evidence or recorded as a defect, but never converted
into an artificial 1–5 score.

### Stage 2.4 — Compose judge requests

For every valid blinded row:

1. load universal kernel;
2. load universal metrics;
3. load track/application rubric;
4. add comparative metrics only when silver is enabled;
5. generate exact output schema;
6. add rendered input and blinded content;
7. add evidence and abstention rules;
8. calculate layer and final hashes;
9. write request artifact and database row.

Reports refuse to pool different prompt, rubric, or schema hashes.

### Stage 2.5 — Submit LLM analysis batches

For each judge role:

1. select valid rows according to judge sample rate;
2. shard by provider, model, endpoint, schema-compatible track set, and provider limits;
3. create immutable input artifacts;
4. create batch-job and batch-request rows before submission;
5. submit once and persist provider batch ID;
6. poll asynchronously;
7. download output/error artifacts;
8. import by custom ID;
9. normalize provider status, usage, and errors.

The primary judge normally scores every valid row. The secondary judge defaults to deterministic
10% and may be configured at 100%. Results are never matched by position.

There is no standard completion fallback. A provider that cannot satisfy the batch contract
causes validation failure before submission.

Scalability mechanics:

- shard by provider, model, endpoint, schema-compatible track set, or track;
- use deterministic row/custom IDs as idempotency keys;
- flush an append-only result manifest after every imported batch;
- resume completed shards without re-submitting completed batches;
- apply provider-specific rate-limit and transient-error backoff to polling/submission only;
- keep invalid-result retries separate from transport retries;
- assert token estimates before submission and flag renderer regressions;
- run stages after provider import repeatedly without spending additional LLM cost.

### Stage 2.6 — Validate evidence and isolate invalid results

Validation order:

1. provider envelope;
2. JSON/schema;
3. row ID and metric keys;
4. score/abstention/gate consistency;
5. candidate quotes;
6. reference quotes;
7. input field/value resolution;
8. absence validation and semantic-absence flagging;
9. privacy and payload consistency.

For an invalid result:

1. persist raw response and issues;
2. create one isolated retry;
3. submit retry through a new batch;
4. validate using the same contract;
5. accept only a valid retry;
6. after one failed retry, mark invalid and exclude from affected statistics;
7. record retry cost and invalid rate.

Retries never loop indefinitely and never repair content.

### Stage 2.7 — Write the metric ledger

One normalized row per metric result:

~~~text
run_id
row_id
subject_id
application_key
track
stratum_key
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
judge_status
prompt_hash
judge_batch_id
created_at
~~~

Raw judge response remains separately stored and linked by artifact hash. Browser code never
interprets raw provider output.

### Stage 3.1 — Aggregate quality and gates

For every metric, report score, denominator, abstention rate, evidence-channel mix, and CI.

- hard gates are separate eliminators;
- hard gates never enter composite_quality;
- universal soft metrics enter the universal composite;
- track supplements remain track diagnostics;
- conditional metrics abstain when not applicable;
- comparative metrics are absent, not zero, in absolute mode;
- paired deltas use the same subject/case across arms.

### Stage 3.2 — Statistics and decision support

1. Flag models whose hard-gate Wilson upper bound exceeds configured maximum.
2. Flag models whose candidate_degenerate upper bound exceeds tolerance.
3. Find quality leader by composite_quality.
4. Retain models whose interval is within qualityMarginDelta of the leader.
5. Recommend lowest-cost eligible model; latency breaks cost ties.
6. Withhold when all models are flagged, evidence is insufficient, or quality is inside judge
   noise.
7. Route borderline cases and disagreements to human review.

No safety or quality failure can be purchased away with low cost.

### Stage 3.3 — Cost analysis

The canonical usage/cost ledger records source generation, judge, invalid retry, batch,
provider, model, track, subject, and attempt dimensions.

Cost precedence:

1. trusted provider-reported cost;
2. recorded usage times immutable pricing snapshot;
3. unknown when required usage or rate is absent.

Unknown is not zero. A partial cost report cannot produce a fully cost-based recommendation.

### Stage 3.4 — Reports, audit, and human decision

Generate seven reports and eight audits described in Section 13. Human actions are:

~~~text
ACCEPT   accept the engine recommendation
OVERRIDE select another arm and record the reason
DEFER    require another run, more data, or a rubric fix
~~~

The human decision is final.

## 8. Metric suite — authoritative register

The registry, configuration, prompt documentation, and reports must reconcile to:

| Metric category | Count |
|---|---:|
| Universal distinct metrics | 8 |
| Supplementary distinct metrics | 31 |
| Supplementary track assignments | 37 |
| Comparative distinct metrics | 4 |
| Total distinct metric keys | 43 |
| Universal hard-gate keys | 3 |
| Supplementary hard-gate keys | 9 |
| Total distinct hard-gate keys | 12 |
| Supplementary hard-gate assignments | 11 |

The authoritative count is twelve distinct hard-gate metric keys: three universal and nine
track-specific. A shared key may be assigned to multiple tracks.

### 8.1 Universal metrics

| Metric | Class | Gate | Composite |
|---|---|---|---|
| input_grounding | factual | hard | no |
| safety_compliance | factual | hard | no |
| structural_completeness | structural | hard | no |
| personalization | quality | soft | yes |
| internal_consistency | quality | soft | yes |
| voice_alignment | quality | soft | yes |
| usefulness | quality | soft | yes |
| language_quality | quality | soft | yes |

Rules:

- input_grounding catches fabricated or misused supplied facts, not interpretation;
- safety_compliance catches definitive medical, financial, legal, death, fertility, alarmist,
  coercive, or instruction-injection behavior;
- structural_completeness catches missing/empty/truncated sections and template artifacts;
- personalization detects content unchanged for another input;
- internal_consistency requires both contradictory candidate quotes;
- voice_alignment judges accessible, warm, affirming, plainly written style;
- usefulness requires concrete, proportionate, input-connected guidance where applicable;
- language_quality judges repetition, padding, grammar, fluency, and register.

### 8.2 Universal composite

~~~text
composite_quality = weighted mean of:
  personalization
  internal_consistency
  voice_alignment
  usefulness
  language_quality
~~~

Weights are equal by default and live in configuration. A row with an abstention in any
required soft universal metric is partial, excluded from the composite, and counted.

### 8.3 Track-specific assignments

| Track | Supplementary metric | Gate | Condition |
|---|---|---|---|
| natal_brief, natal_detailed | aspect_coverage | soft | none |
| same | house_domain_accuracy | soft | none |
| transit_brief, transit_detailed | transit_timing_relevance | soft | none |
| same | transit_natal_distinction | soft | none |
| same | timing_specificity | soft | none |
| synastry_brief, synastry_detailed | bidirectional_fairness | soft | none |
| same | score_narrative_coherence | soft | none |
| same | challenge_honesty | soft | none |
| composite_brief, composite_detailed | union_entity_framing | soft | none |
| same | score_narrative_coherence | soft | none |
| same | challenge_honesty | soft | none |
| number_compatibility_brief, number_compatibility_detailed | canonical_meaning_fidelity | hard | none |
| same | master_number_handling | hard | master number present |
| same | number_pair_fidelity | soft | none |
| same | score_narrative_coherence | soft | none |
| numerology_brief, numerology_detailed | canonical_meaning_fidelity | hard | none |
| same | master_number_handling | hard | numberValue in {11,22,33} |
| same | number_type_discipline | soft | none |
| same | year_anchoring | soft | numberType = personal_year |
| tarot_brief, tarot_detailed | card_fidelity | hard | none |
| same | position_semantics | soft | none |
| same | spread_coherence | soft | none |
| same | question_responsiveness | soft | none |
| my_day | date_correctness | hard | none |
| same | astronomical_accuracy | hard | none |
| same | cross_section_coherence | soft | none |
| same | transit_timing_relevance | soft | none |
| same | activity_validity | soft | none |
| same | numerology_day_integration | soft | none |
| static_scores | injected_value_fidelity | hard | none |
| same | score_coverage | hard | none |
| same | value_type_correctness | soft | none |
| same | score_interpretation_alignment | soft | none |
| zodiac_profile | sign_attribute_accuracy | hard | none |
| same | famous_people_plausibility | hard | none |
| same | archetype_coherence | soft | none |
| same | cultural_care | soft | none |

Track rules remain in rubric packs. They must not duplicate universal grounding, safety, or
completeness.

### 8.4 Comparative silver metrics

Added only when include_silver_reference is true:

| Metric | Meaning |
|---|---|
| coverage_parity | candidate covers same substantive ground or adds grounded breadth |
| interpretive_agreement | shared interpretive claims substantively agree; low score is a flag, not truth |
| depth_parity | reasoning depth is comparable; depth is not length |
| reference_advantage | which reading better serves the reader from input and purpose |

Categorical silverComparison:

~~~text
equivalent
candidate_richer
silver_richer
substantive_disagreement
candidate_degenerate
~~~

Comparative metrics never enter composite_quality. candidate_degenerate is an eliminator;
substantive_disagreement enters human audit. There is no minimum similarity gate.

### 8.5 Reference contamination and blind-silver checks

The judge must be tested for anchoring on the silver reference. On an early approximately 10%
sample, score identical rows twice: once with silver shown and once without silver.

- If universal scores are materially unchanged, universal scores may be pooled and comparative
  metrics remain a separate axis.
- If scores shift systematically, score universal metrics in a reference-free batch and run
  comparative metrics in a separate silver-enabled batch.
- The topology decision and its cost impact are recorded in the manifest.

When silver is included as a blind arm, it receives universal metrics and gates but is not
compared against itself. Silver's score is reported with that asymmetry explicitly.

### 8.6 Shared metric definitions

The following keys are defined once and referenced by multiple packs:

- score_narrative_coherence — synastry, composite, number compatibility;
- canonical_meaning_fidelity — number compatibility, numerology;
- master_number_handling — number compatibility, numerology;
- transit_timing_relevance — transit, My Day;
- challenge_honesty — synastry, composite.

### 8.7 Aggregation

| Level | Computed |
|---|---|
| Per row/metric | score, gate, abstention, evidence, status |
| Per track/arm/metric | mean, CI, denominator, abstention rate, evidence mix |
| Per track/arm | universal composite, supplement mean, gates, comparative axis, cost |
| Per subject/arm | universal metrics and complete reading-set cost |
| Consolidated | universal metrics, gates, cost, reliability; supplements stay track diagnostics |

## 9. Dataset and track scope

The Cosmic Guidance adapter includes seventeen tracks:

| Track | Strata | Rows per subject |
|---|---|---:|
| natal_brief | chart complexity, birth-time known | 1 |
| natal_detailed | chart complexity, birth-time known | 1 |
| transit_brief | chart complexity, season | 1 |
| transit_detailed | chart complexity, season | 1 |
| synastry_brief | partner archetype | 1 |
| synastry_detailed | partner archetype | 1 |
| composite_brief | partner archetype | 1 |
| composite_detailed | partner archetype | 1 |
| number_compatibility_brief | master-number present | 1 |
| number_compatibility_detailed | master-number present | 1 |
| numerology_brief | numberType × 6 | 6 |
| numerology_detailed | numberType × 6 | 6 |
| tarot_brief | spread, reversed count, question present | 1 |
| tarot_detailed | spread, reversed count, question present | 1 |
| my_day | day, moon phase, season | 1 |
| static_scores | chart complexity | 1 |
| zodiac_profile | sun sign | 1 |

This is twenty-seven rows per subject. Numerology contributes twelve; all other tracks
contribute fifteen. At 100 subjects that is 2,700 rows per generation arm.

Numerology is exhaustive:

- all 71 canonical values are covered;
- both depths produce 142 distinct content pieces;
- every master-number case is human-reviewed;
- coverage is not treated as a sampled estimate.

Excluded tracks remain explicit and do not silently enter runs:

- contextual chat;
- profile image;
- unbuilt cosmic answers;
- deterministic free tools;
- pre-authored/static non-LLM content;
- disconnected or non-functional tracks.

## 10. Statistics and decision rules

### 10.1 Unit and cluster

One row is a subject, track, stratum, and arm. One cluster is one subject. Shared subject
characteristics make rows from one subject non-independent.

~~~text
DEFF ≈ 1 + (m − 1) × ICC
n_effective ≈ n_rows / DEFF
~~~

Report ICC, design effect, and effective sample size beside every pooled statistic.

### 10.2 Paired cluster bootstrap

For each of 10,000 iterations:

1. sample subjects with replacement;
2. include every selected subject row for every arm, track, and stratum;
3. preserve duplicate subject draws;
4. calculate each arm metric mean over scored rows;
5. calculate challenger minus champion deltas on same sampled subjects;
6. take percentile confidence intervals;
7. add visible BCa intervals for materially skewed composite statistics.

Use a fixed recorded seed. Abstentions are excluded from means but reported beside every mean.

### 10.3 Proportions and gates

Bootstrap gate failures, abstentions, degeneracy, substantive disagreement, and unparseable
rates by cluster. Also calculate Wilson intervals. For zero failures, the Wilson upper bound
is the operational signal rather than a claim of zero risk.

### 10.4 Judge reliability

| Check | Default |
|---|---|
| Same-judge rejudge | 10% sample; at least 90% within ±1 |
| Cross-vendor judge | 10% sample; at least 70% within ±1 |
| Gate agreement | separately reported |
| Judge noise | SD of paired rejudge differences per metric |
| Noise-aware ranking | inside noise band means indistinguishable |
| Sanity floor | deliberately weak arm ranks last on every track |
| Silver blind arm | report scores and suspicious uniform advantage |

Low cross-judge agreement requires rubric review, not threshold lowering. Gate disagreements
enter the human audit slice.

### 10.5 Multiple comparisons

Apply Benjamini–Hochberg only to primary paired composite-quality tests. Report raw and
adjusted p-values. Do not correct descriptive diagnostics or zero-tolerance gates.

### 10.6 Pilot and sample size

Run an approximately thirty-subject pilot. Measure paired standard deviation and judge noise,
then estimate the subject count required per track. Do not assume 100 is adequate for every
track. Numerology uses its complete finite input space.

### 10.7 Recommendation procedure

~~~text
1. Gate flag:
   flag if any hard-gate Wilson upper bound exceeds configured tolerance.

2. Degeneracy flag:
   flag if candidate_degenerate upper bound exceeds tolerance.

3. Quality eligibility:
   retain models whose composite-quality interval can be within qualityMarginDelta of leader.

4. Cost selection:
   among eligible, unflagged models, recommend lowest cost per reading.
   Break cost ties with median latency.

5. Withhold:
   return NO RECOMMENDATION if all models are flagged, evidence is incomplete, or differences
   are inside judge noise without a meaningful cost distinction.
~~~

Thresholds are product decisions, not facts. Reports include sensitivity tables for quality
margin and gate tolerances.

### 10.8 Refusals

The engine must refuse to:

- pool different prompt, rubric, or schema hashes;
- impute abstentions;
- rank models within judge noise as meaningful;
- compare cost with unknown pricing or usage;
- combine safety, quality, and cost into one scalar;
- hide ICC or design effect;
- call a gate passed from zero observed failures without Wilson bounds;
- treat silver similarity as truth;
- recommend when a blocking audit failed.

## 11. Cost analysis

Cost is a first-class output at reading, subject, run, provider, model, and overall levels.

### 11.1 Cost event dimensions

~~~text
run
application
track / reading type / depth
subject cluster
generation arm
judge role
provider
model
batch ID
request ID
attempt
stage: source_generation | judge_analysis | invalid_retry
status: success | failed | invalid | unknown
usage_mode: batch
~~~

Record input, output, total, cached, reasoning/prediction tokens when supplied, provider
request ID, timestamps, pricing snapshot, cost source, status, and calculated cost.

### 11.2 Per-reading cost

~~~text
cost = input_tokens / 1,000,000 × input_rate
      + output_tokens / 1,000,000 × output_rate
      + cache_read_tokens / 1,000,000 × cache_read_rate
      + cache_write_tokens / 1,000,000 × cache_write_rate
~~~

Report median and p95 cost, input/output tokens, and latency per track, arm, and judge model.
Use median because output length is right-skewed.

### 11.3 Output-token ceilings preserved in configuration

These are ceilings, not actual usage, and must be verified against the source adapter:

| Track family | Brief | Detailed |
|---|---:|---:|
| natal | 6,000 | 16,000 |
| transit | 6,000 | 16,000 |
| synastry | 6,000 | 16,000 |
| composite | 6,000 | 16,000 |
| number compatibility | 2,000 | 3,500 |
| numerology | 2,000 | 2,000 |
| tarot | 2,000 | 3,000 |
| my day | — | 4,000 |
| static scores | — | 4,000 |
| zodiac profile | — | 6,000 |

### 11.4 Per-subject cost

~~~text
cost_per_subject(config) = sum(cost(row) for that subject's complete reading set)
~~~

Report median, p95, and cluster-bootstrap CI. Always compare champion_uniform, champion on all
tracks, against per_track_optimal, the recommended model independently per track.

### 11.5 Consolidated cost

~~~text
projected_total = sum(volume[track] × cost_per_reading[track, selected_arm])
~~~

Print the source of every track volume. If a track volume is unknown, report per-reading cost
only and mark consolidated projection partial. Never use an unweighted cross-track sum.

### 11.6 Judge cost and caching

Judge input includes kernel, universal metrics, rubric, rendered input, candidate output, and
optional silver output. Judge output includes scores, evidence, rationales, gates, and status.

Rich evidence is intentional: it makes the judge falsifiable. Do not lower evidence limits
below two quotes where a metric requires both sides of a contradiction.

Prompt caching is an optimization, not an assumption. Record projected and observed cache
tokens. Batch pricing and discounts come from the pricing snapshot, not a hardcoded percentage.

### 11.7 Estimate before spending

The estimate command runs materialization, rendering, and prompt preparation without provider
submission and prints per shard:

- row count;
- estimated input/output tokens;
- cacheable prefix;
- provider/model/role cost;
- unknown rates;
- source and judge totals;
- retry allowance.

An estimate is required before a full sweep.

## 12. Neon database model

### 12.1 Core tables

~~~text
eval_applications
eval_datasets
eval_dataset_cases
eval_artifacts
eval_runs
eval_run_stages
eval_run_arms
eval_run_events
eval_source_results
eval_evaluation_rows
eval_rendered_payloads
eval_prompt_versions
eval_precheck_results
eval_batch_jobs
eval_batch_requests
eval_batch_results
eval_judge_results
eval_metric_results
eval_usage_events
eval_pricing_snapshots
eval_pricing_rates
eval_reports
eval_audit_items
eval_human_decisions
~~~

### 12.2 Relationships and constraints

- every run-scoped table references run_id;
- every batch job has provider, model, stage, artifact hash, and lifecycle state;
- every batch request has deterministic custom_id and unique batch/job identity;
- every result references exactly one request and may be imported once;
- every judge result references prompt, schema, and rubric hashes;
- every metric result references one judge result and one definition;
- every usage event references one source, judge, or retry attempt;
- every report references immutable aggregate artifact hashes;
- every human decision references a report and audit version.

### 12.3 Status values

Run:

~~~text
created, validating, ready, running, partially_complete, blocked,
completed, failed, cancelled, decided
~~~

Stage:

~~~text
pending, running, waiting_provider, importing, validating,
completed, partially_complete, blocked, failed
~~~

Batch:

~~~text
prepared, uploaded, submitted, validating, in_progress, finalizing,
completed, partially_failed, failed, expired, cancelling, cancelled, imported
~~~

### 12.4 Artifact storage

Large immutable files remain in local encrypted content-addressed storage:

~~~text
artifacts/<sha256-prefix>/<sha256>
~~~

Neon stores artifact type, hash, path, size, creation time, retention time, and encryption
metadata. Raw prompts and provider responses do not go into logs. Small validated evidence
and report data may be JSONB.

## 13. Reporting and human review

Re-running reports after changing weights or thresholds does not re-run LLM batches.

### 13.1 Seven decision reports

1. **Consolidated decision brief** — recommendation, quality CI, delta versus champion, gates,
   cost, latency, confidence banner, and blocking issues.
2. **Per-subject cost rollup** — median/p95 cost, CI, tail subject, track contribution, and
   missing/unparseable readings.
3. **Per-track model comparison** — every metric, composite, supplements, gates, silver axis,
   cost, latency, frontier, sensitivity table, and recommendation trace.
4. **Per-metric view** — distributions, SD, entropy, discrimination, abstention, agreement,
   noise, evidence mix, and inter-metric correlation.
5. **Evidence drill-down** — rendered input, candidate/reference output, quotes, input refs,
   absences, rationale, gate, raw response, and validation result.
6. **Reliability and validity appendix** — audits, manifest, hashes, seed, bootstrap count,
   and revealed model map after scoring.
7. **Sign-off and decision log** — accept/override/defer, selected model, reason, reviewer,
   date, and component-audit decisions.

Outputs are Markdown, machine-readable JSON, and optional HTML.

### 13.2 Eight component audits

#### Audit 1 — Dataset

Check:

- 100% same-input correspondence across arms;
- declared stratum coverage;
- all 71 numerology values;
- load-status breakdown;
- byte-identical input snapshots;
- PII policy;
- duplicate subject/track/stratum detection.

#### Audit 2 — Prompt

Check:

- one kernel/rubric/schema hash per comparable track;
- human-readable composed prompt sample;
- zero model/provider leakage in blinded payloads;
- cache-prefix behavior where configured;
- schema/rubric key parity.

#### Audit 3 — Judge

Check:

- same-judge agreement;
- cross-vendor agreement;
- gate agreement;
- judge noise band;
- sanity-floor ranking;
- silver blind-arm behavior;
- judge-family independence;
- invalid/error/retry rates.

#### Audit 4 — Evidence

Check:

- candidate quote verbatim rate;
- reference quote verbatim rate;
- input field resolution rate;
- input value match rate;
- exact versus semantic absence split;
- semantic absence human spot-check;
- evidence-channel mix;
- zero accepted empty-evidence scores.

#### Audit 5 — Metrics

Check:

- score distribution and >80% single-value flags;
- SD and entropy;
- inter-metric correlation and >0.9 redundancy flags;
- abstention versus expected conditional abstention;
- 31/9/37/11 register reconciliation;
- composite-weight sensitivity.

#### Audit 6 — Statistics

Check:

- synthetic bootstrap recovery;
- cluster-resampling duplicate behavior;
- ICC and design effect;
- effective sample size;
- Wilson intervals;
- BH correction on primary tests;
- seed reproducibility;
- no abstention imputation;
- prompt-hash pooling guard.

#### Audit 7 — Cost

Check:

- rate-table completeness;
- provider billing reconciliation;
- per-row to run-total token reconciliation;
- projected versus actual cache savings;
- estimate accuracy per shard;
- volume assumption disclosure;
- unknown/partial cost handling.

#### Audit 8 — Gates

Check:

- planted defect caught by every distinct hard-gate metric;
- gate firing counts;
- untested gate labels;
- 100% human review of real gate failures;
- false-positive rate;
- cross-judge gate agreement;
- conditional-gate correctness.

Any failed audit appears in the blocking-issues banner and cannot be silently ignored.

### 13.3 Human review sequence

1. Read confidence banner and blocking issues.
2. Review component audits.
3. Review metric discrimination and redundancy.
4. Review evidence samples per track.
5. Review every hard-gate firing.
6. Review recommendation and threshold sensitivity.
7. Review cost consequence.
8. Record accept, override, or defer with required reasons.

## 14. Observability and privacy

### 14.1 Run events

Every meaningful operation writes JSON logging and an eval_run_events record containing:

~~~text
run_id
stage
event
entity_type
entity_id
status
occurred_at
started_at
finished_at
duration_ms
attempt
provider
model_ref
provider_batch_id
request_count
success_count
failure_count
error_code
artifact_hash
~~~

Logs never contain API keys, raw prompts, full responses, PII, or model identity during
blinded evaluation.

Track observed provider timing separately from model latency. Batch APIs generally provide job
lifecycle timestamps, not exact per-request compute duration. Do not invent precision the
provider did not supply.

OpenTelemetry may be added later for local traces and metrics. It is not required initially
because database events and JSON logs provide the required observability.

### 14.2 Privacy controls

The process is local, but Neon and external providers are remote privacy boundaries.

| Class | Default policy |
|---|---|
| Synthetic/public | may be stored and sent normally |
| Internal | minimize raw Neon storage; use approved provider project/settings |
| Personal/sensitive | redact/pseudonymize; keep raw artifacts local/encrypted; use local inference if necessary |

Required controls:

- no raw prompt/response in logs;
- no production user foreign keys in rows;
- PII scan before source and judge batch;
- redaction/pseudonymization before provider submission;
- TLS for Neon;
- least-privilege database role;
- provider keys in environment/OS secret storage;
- artifact retention and deletion policy;
- localhost-only API by default;
- dashboard access control when needed;
- provider-specific data-retention review before real-data runs.

If data cannot leave the local environment, external provider evaluation is not allowed for
that run. A local model runner can later implement the same BatchProvider port.

## 15. Cosmic Guidance adapter

| Responsibility | Target implementation |
|---|---|
| Source subjects | synthetic/de-identified dataset with opaque IDs |
| Calculations | source-owned deterministic calculator results |
| Source generation | provider batch requests using source prompts |
| Source batch | existing OpenAI batch preparation/import behind generic lifecycle |
| Track mapping | adapter-owned YAML/config |
| Renderers | one renderer per output shape returning RenderedContent |
| Track checks | adapter pre-check registry |
| Rubrics | application-owned rubric packs |
| Coverage/blockers | manifest and run-blocking validation |
| Trusted facts | immutable input snapshot/reference tables |

First vertical slice:

~~~text
Cosmic source batch
  → numerology materialization
  → render and blind
  → primary judge batch
  → evidence validation
  → metric ledger
  → statistics and cost
  → report and human decision
~~~

Then add secondary judging, silver/reference mode, Tarot/My Day, chart tracks, static scores,
and zodiac.

## 16. Future application onboarding

To add another application, provide:

1. adapter registration and version;
2. source import/generation contract;
3. canonical case materializer;
4. renderer returning RenderedContent;
5. application deterministic pre-checks;
6. track definitions and strata;
7. application rubric packs;
8. metric assignments;
9. generation/provider configuration;
10. pricing configuration;
11. synthetic fixture dataset;
12. adapter contract tests.

No changes should be needed in the universal kernel, evidence validator, batch state machine,
provider-neutral orchestration, metric ledger, statistics, cost aggregation, report format, or
human decision semantics.

The second application is a mandatory boundary test.

## 17. Delivery phases and exit gates

### Phase 0 — Contracts and scope freeze

Implement:

- Python project skeleton;
- Pydantic contracts;
- run manifest;
- application/provider ports;
- metric registry counts;
- absolute/reference mode;
- judge sample-rate semantics;
- batch-only execution validation;
- legacy path read-only marker.

Exit gate:

- standard-only provider configuration cannot start;
- no core import of an adapter;
- run manifest is reproducible without provider call.

### Phase 1 — Neon foundation and local operations

Implement:

- SQLAlchemy models and Alembic migrations;
- pooled/direct Neon connections;
- repositories and transactions;
- artifact store;
- run/stage/event state machine;
- JSON logging;
- Typer commands;
- FastAPI status/report endpoints;
- localhost dashboard serving.

Exit gate:

- create, resume, block, fail, and complete a mock run;
- every transition has timestamps and database events;
- process restart does not lose state.

### Phase 2 — Generic provider batch layer

Implement:

- mock batch provider;
- OpenAI batch adapter using existing fixtures;
- lifecycle normalization;
- deterministic custom IDs;
- result/error import;
- usage normalization;
- isolated invalid retry;
- duplicate/missing/unknown result detection;
- provider sharding limits.

Exit gate:

- mock and OpenAI-shaped fixtures use identical core code;
- repeated import is idempotent;
- no direct completion method exists in production interfaces.

### Phase 3 — Generic source generation and Cosmic adapter

Implement:

- source import and source batch generation;
- Cosmic calculators and renderers behind adapter ports;
- generation arms and output contracts;
- coverage/blocker checks;
- source cost events;
- existing batch corpus verification.

Exit gate:

- one Cosmic source run produces complete canonical cases;
- imported and newly generated batches have the same shape;
- source costs reconcile.

### Phase 4 — Judge prompts, blinding, and evidence

Implement:

- kernel/metric/rubric loading and hashes;
- per-track schema generation;
- arm sealing and payload leakage tests;
- primary/secondary judge batches;
- structured response validation;
- evidence validator;
- abstention handling;
- one retry and invalid quarantine;
- normalized metric ledger.

Exit gate:

- a valid row is scored, abstained, or explicitly invalid;
- every accepted score has valid evidence;
- no model identity leaks;
- invalid output never becomes a score through repair.

### Phase 5 — Metrics, statistics, and cost

Implement:

- all 43 metric keys and track assignments;
- composite and supplement aggregation;
- silver comparative axis;
- cluster bootstrap and Wilson intervals;
- judge reliability/noise;
- BH adjustment;
- canonical usage/cost ledger;
- estimate versus actual;
- quality/cost decision support;
- NO RECOMMENDATION behavior.

Exit gate:

- known-effect bootstrap fixture passes;
- all hard-gate planted defects are detected;
- cost totals reconcile;
- unknown prices remain unknown;
- recommendations are withheld when gates/audits fail.

### Phase 6 — Reports, audit, and human decision

Implement:

- seven reports;
- eight audits;
- evidence drill-down;
- review sampling;
- accept/override/defer decisions;
- immutable human decision history;
- threshold sensitivity tables.

Exit gate:

- reviewer can trace recommendation from manifest to raw response and evidence;
- report separates recommendation from human decision;
- every blocking audit is visible.

### Phase 7 — Second application boundary and cutover

Implement:

- fixture application adapter;
- complete adapter-independent E2E run;
- dependency/vocabulary boundary tests;
- Cosmic track expansion;
- retirement of per-case Cloud Tasks/direct provider paths;
- documentation and operational runbook.

Exit gate:

- second adapter runs without core modifications;
- all new runs use universal manifest and batch lifecycle;
- old runtime paths are read-only or removed.

### Track rollout order after the foundation

The order is based on iteration cost and calibration value, not product importance:

1. **Numerology brief and detailed** — one integer input, finite 142-case space, cheap
   judge requests, exact grounding, conditional master-number and personal-year behavior.
   Score all 142 content pieces and manually review all master-number cases.
2. **Statistics, cost, and pilot calibration** — run every configured arm on numerology,
   validate bootstrap recovery, cost reconciliation, metric register, evidence audits, and
   calculate the required subject count per later track from the pilot.
3. **Judge calibration** — run same-judge rejudge, cross-vendor judge, reference-contamination
   check, silver blind-arm check, human audit slice, Reports 6 and 7, and planted defects for
   every gate reachable so far. Do not proceed while agreement or human defensibility fails.
4. **Tarot and My Day** — validate card orientation/position, General guidance behavior,
   date correctness, astronomical accuracy, activity validity, and cross-section coherence.
5. **Chart tracks** — natal, transit, synastry, composite, and number compatibility. These
   are more expensive and less structurally constrained; require discriminating aspect,
   house, timing, bidirectional, union, pair-fidelity, and score-narrative results.
6. **Static scores and zodiac profile** — validate exact injected-score fidelity, score
   coverage, sign attributes, and the famous-person plausibility hallucination trap. Unknown
   famous-person facts must produce input_insufficient abstention, not guessing.
7. **Full sweep and decision** — all 17 tracks and all arms, all seven reports, all eight
   audits, billing reconciliation, human review, and per-track decisions.
8. **Hardening** — restart/resume under failures, provider backoff, shard parallelism, report
   polish, retention cleanup, and scheduled reruns such as annual personal-year regeneration.

Every track rollout requires its applicable planted-defect tests. A gate that has never fired
is labelled UNTESTED, not passed. A deliberately weak sanity-floor arm must be included in the
full sweep; if it does not rank last on every track, the judge results are void.

## 18. Testing and verification matrix

### 18.1 Contract tests

- Pydantic contracts reject missing IDs and invalid status combinations;
- every track has renderer, rubric, schema, and metric registration;
- metric totals reconcile to 43/12/37/11;
- second fixture adapter executes without Cosmic imports;
- application adapters cannot change universal metric definitions.

### 18.2 Batch tests

- deterministic preparation;
- provider status transitions;
- retry-safe polling;
- restart/resume;
- output-order independence;
- duplicate custom ID rejection;
- missing-result detection;
- unknown custom ID quarantine;
- error-file import;
- cancellation and expiry handling;
- isolated failed-line retry;
- usage/cost non-duplication.

### 18.3 Blinding and prompt tests

- no model/provider/family strings in blinded payloads;
- sealed arm map inaccessible to prompt/judge code;
- prompt hashes reproduce payloads;
- schema keys equal rubric keys;
- reference-free and reference-enabled modes distinct;
- silver cannot be compared with itself.

### 18.4 Evidence tests

- paraphrased quote rejected;
- quote from wrong output rejected;
- missing input field rejected;
- mismatched input value rejected;
- required missing section resolved exactly;
- semantic absence flagged rather than trusted;
- empty evidence rejected;
- gate failure requires violation and evidence;
- abstention shape is valid and unscored.

### 18.5 Metric/statistics tests

- composite excludes gates and supplements;
- conditional metrics abstain exactly when expected;
- known bootstrap effect recovered;
- duplicate cluster draws preserve all rows;
- same seed reproduces intervals;
- Wilson upper bound exists for zero failure;
- BH applies only to primary tests;
- prompt-hash mismatch blocks pooling;
- discrimination and redundancy reports work.

### 18.6 Cost/privacy tests

- selected model rates exist or run is unpriced;
- per-row usage sums to batch/run usage;
- source and judge cost remain separate;
- invalid retry cost is additional;
- estimate/actual variance is reported;
- logs contain no prompt, response, key, or PII;
- PII fixture is rejected or redacted according to policy;
- artifact retention/deletion works.

### 18.7 End-to-end gates

1. mock source batch to canonical generation rows;
2. mock primary/secondary judge batch to validated metrics;
3. Cosmic Guidance adapter through generic path;
4. second fixture adapter without core changes;
5. pre-check defect path;
6. invalid judge result to isolated retry and quarantine;
7. missing batch result to incomplete run and no recommendation;
8. hard-gate failure to evidence drill-down and human review;
9. cost reconciliation at reading and overall levels;
10. accepted, overridden, and deferred decisions;
11. report regeneration without another provider call;
12. process restart and resume from every batch lifecycle state.

## 19. Definition of done

The rewritten universal judge is complete when:

- service runs locally using approved Python stack and Neon;
- source application can be any stack through an adapter boundary;
- source generation and judge analysis are batch-only for real providers;
- no direct provider fallback exists;
- universal core is independent from Cosmic Guidance;
- all 43 metrics and 12 distinct hard-gate keys are registered;
- all 17 first-application tracks are represented and unsupported tracks are explicit;
- numerology's 71-value/142-content exhaustive policy is enforced;
- prompts, rubrics, schemas, data, code, pricing, and statistics are versioned;
- every score is evidence-grounded or explicitly abstained/invalid;
- invalid results are retried once and then isolated;
- run events include status, timestamps, duration, attempts, and provider IDs;
- generation and judge cost are separately and jointly reported;
- unknown cost never becomes zero;
- cluster statistics, judge noise, Wilson bounds, and multiplicity are reported;
- silver similarity is a separate axis, never truth or composite objective;
- seven reports and eight audits are generated;
- failed audits block or visibly qualify recommendations;
- a human records final accept/override/defer decision;
- a second application adapter runs without universal-core changes.

## 20. Immediate implementation order

1. Create Python project and lockfile.
2. Create Neon schema, migrations, connection roles, and artifact registry.
3. Implement Pydantic contracts and run/stage/event state machine.
4. Implement mock batch provider and resumable worker.
5. Port existing OpenAI batch fixtures behind BatchProvider.
6. Implement generic adapter registry and fixture application.
7. Implement Cosmic Guidance source import/generation adapter.
8. Implement materialization, rendering, blinding, and leakage tests.
9. Implement kernel/rubric/schema composition and hashes.
10. Implement primary judge batch, result import, evidence validation, and one retry.
11. Run numerology vertical slice end to end.
12. Implement metric-ledger aggregation and hard-gate reporting.
13. Implement bootstrap, Wilson intervals, judge reliability, and decision support.
14. Implement generation/judge cost events, estimates, and reconciliation.
15. Implement seven reports and eight audits.
16. Add secondary judge and silver/reference mode.
17. Add second application adapter boundary test.
18. Expand remaining Cosmic Guidance tracks.
19. Retire legacy direct-call and per-case orchestration paths.

The first successful run is not the finish line. It must be reproducible, auditable,
cost-reconciled, evidence-valid, and human-reviewable before it is used to make a model
recommendation.
