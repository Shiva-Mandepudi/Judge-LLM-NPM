Deeply analyze the existing Cosmic Guidance and `judge-service` codebase before making changes, especially:

* `server/services/numerologyInsightService.ts`
* `server/services/numerologyGenerationService.ts`
* `server/services/judge/track-adapters.ts`
* `server/routes/internal-judge-routes.ts`
* `prompts/numerology/`
* `judge-service/shared/dataset-types.ts`
* `judge-service/scripts/generate-synthetic-datasets.ts`
* Existing Judge dataset registration, validation, audit and configuration code

Then implement an industry-standard, end-to-end numerology gold-dataset pipeline. Do not stop after analysis or planning—implement, migrate, test and document the complete solution.

## Objective

Build a hybrid pipeline where:

1. Cosmic Guidance remains the source of truth for valid numerology values, calculations, prompt rendering, schemas and deterministic validation.
2. Cosmic Guidance code generates exact production-equivalent OpenAI Batch JSONL requests.
3. OpenAI Batch generates draft numerology outputs asynchronously.
4. Results are reconciled using deterministic `custom_id` values.
5. Cosmic Guidance schemas and deterministic checks validate every output.
6. Human review is required before any output can be marked `human_verified`.
7. The final immutable dataset can be registered with the existing Judge service.
8. Nothing automatically changes production AI routing or seeds the live numerology cache.

## Strict constraints

* Do not use real users, production user records, names, birth data, auth tokens, subscriptions, credits or PII-vault data.
* Do not charge credits, create readings, write user-facing caches or mutate product data.
* Do not introduce Redis, Memorystore or Redis-backed locking.
* Do not duplicate numerology calculators, prompts, schemas or placeholder logic inside `judge-service`.
* Do not manually copy prompt text into dataset files or scripts.
* Do not hardcode API keys, secrets, model names, years, prompt paths or pricing.
* Do not silently fall back to another model, prompt, mock provider or synchronous generation.
* Do not mark model-generated content as gold or approved without recorded human review.
* Preserve current UI, subscriptions, entitlements and production behavior.
* Reuse existing services and database structures wherever correct; add migrations only where genuinely necessary.
* Remove or consolidate duplicate/legacy prompt paths only after proving they are unused.
* Preserve unrelated user changes in the repository.

## Canonical dataset scope

Generate the valid combinations from one authoritative registry derived from existing CG calculator rules:

* Life Path: `1–9, 11, 22, 33` = 12 values
* Expression: `1–9, 11, 22, 33` = 12
* Soul Urge: `1–9, 11, 22, 33` = 12
* Personality: `1–9, 11, 22, 33` = 12
* Birthday: `1–9, 11, 22` = 11; reject 33 unless current CG rules explicitly prove otherwise
* Personal Year: `1–9, 11, 22, 33` = 12

Total: 71 canonical value keys × brief/detailed = exactly 142 output cases.

Personal Year case keys must include the target year. Its annual refresh must cover 12 values × 2 depths = 24 outputs. Never silently reuse content from the wrong year.

Do not use “100 people × 12 readings” for this permanent content dataset. That belongs to a separate future calculator-conformance dataset because it produces many duplicate canonical content keys.

## Shared production request builder

Create a pure shared builder, following existing project conventions, such as:

`server/services/numerology-generation-request-builder.ts`

It must be used by:

* Normal Cosmic Guidance numerology generation
* `/api/internal/judge/generate`
* The OpenAI Batch dataset builder

The builder must accept the canonical inputs and return:

* Exact rendered system prompt
* Exact rendered user prompt
* Prompt version
* SHA-256 prompt hash
* Schema version
* Strict response schema
* Requested model
* Generation settings
* Calculator/rules version
* Canonical case metadata

Ensure the normal production path remains behaviorally unchanged after the refactor.

## Prompt-version enforcement

Implement an allow-listed prompt registry:

* Map each supported `promptVersion` to one exact file in `prompts/numerology/`.
* Reject unknown, missing or path-traversal prompt versions.
* Never infer a different prompt when an explicit version was requested.
* Calculate and return a deterministic SHA-256 hash of the resolved prompt content.
* Fail if unresolved `{{...}}` placeholders remain.
* Persist prompt version and hash in the manifest and final dataset.
* Ensure `promptVersion` genuinely controls generation rather than being informational metadata.

## Strict schemas and deterministic validation

Add or reuse strict Zod schemas for brief and detailed numerology output.

Validate:

* Required root and nested objects
* Required text fields
* Empty or whitespace-only values
* Unexpected fields where appropriate
* Valid number type/value
* Correct expected root key
* Truncation/incomplete sections
* Master-number handling for 11, 22 and 33
* Input number not modified by generation
* Personal Year context and year consistency
* Unsafe medical, financial, legal, diagnostic, medication, lottery or absolute-certainty claims
* JSON/schema correctness after Batch ingestion

Return structured validation errors with stable error codes. Never report `schemaValid: true` merely because JSON parsing succeeded.

## Dataset and artifact structure

Use versioned, immutable dataset directories:

```text
judge-service/datasets/numerology/v1/
├── cases.jsonl
├── manifest.json
├── reviewed-gold.jsonl
└── checksum.json
```

Keep temporary/raw Batch artifacts in a gitignored working directory:

```text
judge-service/.artifacts/numerology/v1/<run-id>/
├── batch-input.jsonl
├── batch-output.jsonl
├── batch-errors.jsonl
├── generated-drafts.jsonl
├── validation-report.json
└── review-package.jsonl
```

Do not create a fake `reviewed-gold.jsonl`. It may remain absent or contain only genuinely reviewed records.

Every canonical case must include:

* `caseKey`
* Track
* Number type/value
* Brief/detailed mode
* Year when applicable
* Gold facts
* Expected root key
* Master-number flag
* Prompt version/hash
* Schema version
* Calculator/rules version
* Dataset version
* Generation configuration
* Provenance fields
* Review status

## OpenAI Batch scripts

Implement idempotent CLI scripts following existing TypeScript tooling:

1. Build and validate the 142-case manifest.
2. Run a configurable 12-case CG dry run covering all six number types and both depths.
3. Build OpenAI Batch JSONL from the shared request builder.
4. Upload the file with `purpose=batch`.
5. Create the Batch using the production-compatible endpoint.
6. Check/poll Batch status without blocking the application.
7. Download output and error files.
8. Reconcile results using `custom_id`.
9. Validate every response.
10. Generate a human-review package.
11. Import human-review decisions and corrections.
12. Export the final immutable Judge dataset.
13. Register it through the existing Judge dataset-registration workflow.

Use deterministic IDs such as:

```text
numerology-v1-life_path-11-brief-draft-1
numerology-v1-personal_year-7-detailed-2026-draft-2
```

Support a configurable number of drafts per case, defaulting to two. If different models are requested, create separate Batch input files because one Batch file must target one model.

Model snapshot, temperature, output limit and other generation settings must be explicit configuration and included in provenance. Use low/no randomness for reference drafting when supported, but do not modify normal production settings.

## Batch reconciliation requirements

Never rely on output order.

The reconciler must detect:

* Missing `custom_id`
* Unknown IDs
* Duplicate IDs
* Missing cases
* Duplicate case/draft combinations
* Provider errors
* Expired requests
* Non-200 responses
* Empty outputs
* Malformed JSON
* Schema failures
* Number/year mismatches
* Validation failures

Only missing or failed lines may be placed into a bounded retry Batch. Never resubmit successful cases. Retries must have a configurable limit and retain a complete attempt history.

A run cannot become `ready_for_review` unless every expected case/draft is accounted for.

## Human review workflow

Implement an auditable state machine:

```text
generated
→ validation_failed | pending_review
→ reviewer_1_approved
→ reviewer_2_approved
→ human_verified
```

Also support:

```text
rejected
needs_correction
corrected
superseded
```

Require two distinct reviewer identifiers before `human_verified`. Reviewer decisions must record:

* Reviewer ID
* Timestamp
* Decision
* Notes
* Selected draft
* Corrections
* Previous and final content hashes

The review criteria must cover:

* Canonical meaning fidelity
* Master-number correctness
* Brief/detailed completeness
* Internal consistency
* Cosmic Guidance tone
* Usefulness
* Safety
* Schema validity
* Absence of generic or irrelevant filler

The final reference output may be human-corrected. Preserve both the original draft and reviewed result for auditability.

## Provenance and reproducibility

Every generated and reviewed record must retain:

* Dataset version
* Dataset checksum
* Git commit SHA
* Calculator/rules version
* Prompt version
* Prompt hash
* Schema version
* Exact model snapshot
* Provider
* Temperature/settings
* OpenAI Batch ID
* OpenAI request ID
* Token usage
* System fingerprint when returned
* Generation timestamp
* Attempt number
* Reviewer history
* Content hashes

Repeated manifest generation with unchanged inputs must produce identical case keys, ordering and checksum.

## Security

* Use the existing OpenAI SDK and environment/Secret Manager configuration.
* Never print secrets or complete sensitive headers.
* Reject raw personal fields in dataset input.
* Ensure all dataset-generation code is side-effect-free toward product data.
* Apply file permissions and safe path handling.
* Sanitize logged model output and avoid uncontrolled full-output logging.
* Validate file size and JSONL line size before upload.
* Use atomic file writes for manifests and finalized datasets.
* Use temporary files plus rename to prevent partial artifacts.
* Add an explicit confirmation flag for actual paid Batch submission; dry-run must be the default.

## Testing

Add comprehensive unit and integration tests covering:

* Exactly 71 canonical keys and 142 output cases
* Exactly 24 Personal Year outputs for a yearly refresh
* Birthday 33 rejection
* Deterministic ordering, IDs and checksums
* Correct prompt resolution and hashing
* Explicit prompt-version enforcement
* Unresolved-placeholder rejection
* Strict brief/detailed schema validation
* Master-number cases
* Personal Year context
* Batch JSONL validity
* Out-of-order result reconciliation
* Duplicate, missing, expired and failed Batch lines
* Retry-only-failed behavior
* Idempotent re-runs
* Review state transitions
* Two distinct reviewer requirement
* Final content hashing
* No user/credit/subscription/cache writes
* Mocked OpenAI Batch tests with no paid API dependency
* Existing production numerology regression tests

Run all relevant type checks, unit tests, integration tests, dataset validation and existing Judge tests. Fix regressions caused by this work; do not suppress failures.

## Documentation and handoff

Add a runbook explaining:

* Required environment variables
* Safe dry-run command
* 12-case CG verification command
* Manifest generation
* Paid Batch submission
* Status checking
* Result download/reconciliation
* Failed-line retry
* Human-review import/export
* Final checksum generation
* Judge dataset registration
* Annual Personal Year refresh
* Recovery from partial or expired Batch runs

At completion, report:

* Files changed
* Migrations added
* Commands to run
* Test results
* Final canonical case counts
* Security checks
* Remaining human-only actions
* Any assumptions discovered from the existing calculator or prompt code

## Acceptance criteria

The work is complete only when:

* The production, Judge and Batch paths use the same prompt builder.
* `promptVersion` selects the exact prompt and its hash is recorded.
* The manifest contains exactly 142 valid cases.
* Batch files are created automatically from CG code.
* Results reconcile by `custom_id`, independent of order.
* Every output passes strict schema and deterministic validation or is explicitly failed.
* No output becomes gold without two recorded human approvals.
* The dataset is immutable, checksummed and reproducible.
* No PII or product-side effects exist.
* No Redis/MemoryStore dependency is introduced.
* Existing user-facing numerology behavior remains unchanged.
* Nothing automatically activates the dataset in production.
