# Numerology Gold Dataset Pipeline

This pipeline creates the permanent, human-reviewed numerology reference dataset used by the Judge service. It does not write product readings, caches, subscriptions, credits, or AI routing.

## What is implemented

- Canonical registry: 71 values × brief/detailed = 142 cases.
- Birthday values: 1–9, 11, 22; 33 is rejected.
- Personal Year: requires an explicit target year and produces 24 cases per yearly refresh.
- Shared prompt rendering and strict output schema from the existing files in `prompts/numerology/`.
- SHA-256 prompt, source-prompt, dataset, and content hashes.
- OpenAI Chat Completions Batch JSONL generation.
- Paid Batch submission requires `--confirm-paid true`; default is dry run.
- Out-of-order Batch reconciliation by deterministic `custom_id`.
- Missing/duplicate/unknown/error/malformed/schema-invalid result detection.
- Retry input generation for only missing or failed outputs.
- Review package and two-distinct-reviewer state transition to `human_verified`.
- Immutable export to `judge-service/datasets/numerology/<version>/`.
- Registration through the existing Judge admin dataset API.

The implementation is split between:

- [`server/services/numerology-generation-request-builder.ts`](../../server/services/numerology-generation-request-builder.ts) — prompt registry, rendering, schema generation, canonical validation.
- [`server/services/numerology-gold-dataset.ts`](../../server/services/numerology-gold-dataset.ts) — manifest, Batch JSONL, reconciliation, hashes.
- [`scripts/numerology-gold-pipeline.ts`](../../scripts/numerology-gold-pipeline.ts) — operator CLI.

## End-to-end flow

```text
manifest
  -> batch-input
  -> batch-submit (explicit paid confirmation)
  -> batch-status / batch-download
  -> reconcile
  -> retry-input (only failed/missing lines)
  -> review-package
  -> review-import (reviewer 1 + reviewer 2)
  -> export
  -> register
```

Temporary artifacts belong under `judge-service/.artifacts/`, which is gitignored. Final datasets belong under `judge-service/datasets/numerology/<version>/`.

## Commands

Run commands from the repository root:

```bash
npm run numerology:gold -- manifest \
  --version v2 \
  --year 2026 \
  --model <explicit-batch-model> \
  --out judge-service/.artifacts/numerology/v2/manifest.json
```

This creates exactly 142 canonical cases. `--year` is mandatory because Personal Year cases must not silently use the wrong year.

Build two drafts per case:

```bash
npm run numerology:gold -- batch-input \
  --manifest judge-service/.artifacts/numerology/v2/manifest.json \
  --drafts 2 \
  --out judge-service/.artifacts/numerology/v2/batch-input.jsonl
```

Dry-run submission is the default:

```bash
npm run numerology:gold -- batch-submit \
  --input judge-service/.artifacts/numerology/v2/batch-input.jsonl
```

Paid submission requires the explicit flag and the normal OpenAI environment/secret configuration:

```bash
npm run numerology:gold -- batch-submit \
  --input judge-service/.artifacts/numerology/v2/batch-input.jsonl \
  --confirm-paid true \
  --out judge-service/.artifacts/numerology/v2/batch-run.json
```

Check and download:

```bash
npm run numerology:gold -- batch-status \
  --run judge-service/.artifacts/numerology/v2/batch-run.json

npm run numerology:gold -- batch-download \
  --run judge-service/.artifacts/numerology/v2/batch-run.json \
  --out-dir judge-service/.artifacts/numerology/v2
```

Reconcile output without relying on provider output order:

```bash
npm run numerology:gold -- reconcile \
  --manifest judge-service/.artifacts/numerology/v2/manifest.json \
  --output judge-service/.artifacts/numerology/v2/batch-output.jsonl \
  --drafts 2 \
  --out judge-service/.artifacts/numerology/v2/reconciled.json
```

Create only failed/missing retry lines:

```bash
npm run numerology:gold -- retry-input \
  --manifest judge-service/.artifacts/numerology/v2/manifest.json \
  --reconciled judge-service/.artifacts/numerology/v2/reconciled.json \
  --drafts 2 \
  --out judge-service/.artifacts/numerology/v2/retry-input.jsonl
```

Create a review package:

```bash
npm run numerology:gold -- review-package \
  --manifest judge-service/.artifacts/numerology/v2/manifest.json \
  --reconciled judge-service/.artifacts/numerology/v2/reconciled.json \
  --out judge-service/.artifacts/numerology/v2/review-package.jsonl
```

Reviewer decisions are JSONL. Each reviewer must use a distinct stable identifier:

```json
{
  "customId": "numerology-v2-life_path-11-brief-draft-1",
  "reviewerId": "reviewer-a",
  "decision": "approve",
  "selectedDraft": 1,
  "notes": "Canonical master-number meaning is accurate and complete."
}
```

Import reviewer 1, then reviewer 2:

```bash
npm run numerology:gold -- review-import \
  --package judge-service/.artifacts/numerology/v2/review-package.jsonl \
  --decisions reviewer-1.jsonl

npm run numerology:gold -- review-import \
  --package judge-service/.artifacts/numerology/v2/review-package.jsonl \
  --decisions reviewer-2.jsonl
```

Export is blocked unless every one of the 142 cases has exactly one `human_verified` draft and the final output still passes strict validation:

```bash
npm run numerology:gold -- export \
  --manifest judge-service/.artifacts/numerology/v2/manifest.json \
  --package judge-service/.artifacts/numerology/v2/review-package.jsonl \
  --out-dir judge-service/datasets/numerology/v2
```

Register the immutable dataset through the existing Judge API:

```bash
export JUDGE_SERVICE_BASE_URL="http://localhost:8081"
export JUDGE_ADMIN_SHARED_SECRET="<secret-reference-value>"
npm run numerology:gold -- register --version v2
```

## Review states

```text
generated
  -> validation_failed
  -> pending_review
  -> reviewer_1_approved
  -> human_verified

pending_review -> rejected
pending_review -> needs_correction -> corrected -> reviewer_1_approved
```

The package retains reviewer ID, timestamp, decision, notes, selected draft, corrections, previous content hash, final content hash, and the complete review history.

## Final dataset files

```text
judge-service/datasets/numerology/v2/
├── cases.jsonl
├── manifest.json
├── reviewed-gold.jsonl
└── checksum.json
```

`cases.jsonl` is the file consumed by the existing Judge dataset registration workflow. The Judge service stores its normal de-identified case fields; the complete gold output and review provenance remain in the immutable exported artifacts.

## Important boundaries

- The pipeline uses the existing prompt registry and calculator rules; it does not copy prompt text or implement a second numerology calculator.
- Batch model and generation settings are explicit manifest data, not hidden defaults.
- One Batch input file contains one model. The builder rejects manifests containing multiple models.
- A missing or failed output is never treated as a successful case.
- Human verification is required before export.
- Export does not seed production numerology content and does not alter provider/model routing.
