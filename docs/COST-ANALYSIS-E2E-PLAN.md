# Cost Analysis Dashboard — End-to-End Implementation Plan

**Status:** Implemented — 2026-09: phases A–E complete; migrations 0011 and 0012 are applied. Migration 0012 adds the complete LLM request-attempt ledger.

**Scope:** Add cost visibility for candidate generation and judge analysis without introducing a daily pricing scheduler, changing the fixed 100-user dataset, or changing the existing LLM winner/report behavior.

## 1. Outcome

The judge service will provide a reliable Cost & Usage dashboard for every comparison run.

The dashboard will:

- calculate cost from recorded token usage and an approved official price snapshot;
- separate candidate-generation cost from primary-judge and secondary-judge cost;
- show cost by run, reading, model, and user;
- provide a pre-run estimate without making an LLM call;
- preserve the exact pricing snapshot used by historical runs;
- clearly mark `unknown`, `partial`, and `estimated` values;
- never display missing cost as `$0`;
- refresh official model prices only when an operator presses a button.

## 2. What will not be built

- No daily or background pricing scheduler.
- No manually maintained rate entry for every model.
- No deletion or recreation of the fixed 100-user dataset.
- No cost charge for the preserved current dataset reading as a new generation.
- No cost-only model recommendation that bypasses quality and safety gates.
- No fabricated monthly production volume.
- No provider API key stored in the pricing sync tables.

## 3. Current state and gaps

Existing pieces to reuse:

- `server/core/cost/cost.ts` contains token-based cost primitives.
- `server/core/pipeline/estimate.ts` contains an early estimate path.
- `evalGenerations` already has most candidate usage and cost fields.
- `evalJudgeScores` already has token and cost columns.
- Comparison runs and reports already exist in `server/services/comparison-service.ts` and `server/services/comparison-run-report.ts`.
- Official provider model discovery already exists through `provider-models-service.ts`.

Required corrections:

- Judge token usage must be propagated from provider responses and persisted.
- Candidate usage must persist cache, reasoning, and total-token fields consistently.
- Provider-reported cost must be retained when available.
- Missing provider cost must be calculated from a versioned price snapshot.
- `config/models.yaml` currently has unresolved rates and cannot be treated as a paid-run price source.
- The current report has no aggregated cost section or link to a cost dashboard.

## 4. Pricing model

### 4.1 Manual official-price sync

Add a **Sync official prices** button under Reviews & Settings.

The action will:

1. Load the currently supported official model catalog for OpenAI, Anthropic, and Gemini.
2. Fetch or parse the provider’s official pricing source through a provider-specific adapter.
3. Normalize prices into the judge-service format.
4. Validate model IDs, token categories, currency, and effective dates.
5. Write a new immutable price snapshot only when validation succeeds.
6. Return a sync summary showing added, updated, unchanged, retired, and unresolved models.

The sync is operator-triggered only. The latest successful snapshot is reused until another manual sync succeeds.

### 4.2 Normalized price record

Each price entry must contain:

```text
provider
modelId
usageMode                  standard | batch | priority | other
inputUsdPerMillionTokens
outputUsdPerMillionTokens
cacheReadUsdPerMillionTokens
cacheWriteUsdPerMillionTokens
currency
effectiveFrom
effectiveTo
sourceUrl
sourceHash
fetchedAt
snapshotId
```

Fields that a provider does not publish remain `null`; they must not become zero.

### 4.3 Historical immutability

When a run starts, store the selected `pricingSnapshotId` on the run/config evidence. Cost calculations for that run always use that snapshot, even after a newer sync occurs.

This prevents a later provider price change from rewriting old reports.

### 4.4 Cost source precedence

For each provider call:

1. Use trusted provider-reported cost when present and documented.
2. Otherwise calculate from persisted token usage and the run’s price snapshot.
3. If usage or price is unavailable, return `unknown`.

The calculated value must include input, output, cache-read, and cache-write categories when those usages exist.

## 5. Database plan

Add migrations for pricing snapshots/run linkage and complete request telemetry. Result tables remain the source for billable cost totals; the request ledger is observability-only and prevents failed/retried calls from disappearing or being double-counted.

### 5.1 Pricing tables

Recommended tables:

#### `eval_pricing_snapshots`

- `id`
- `status` (`valid`, `failed`)
- `triggered_by`
- `created_at`
- `completed_at`
- `source_summary`
- `error_summary`

#### `eval_pricing_rates`

- `snapshot_id`
- `provider`
- `model_id`
- `usage_mode`
- input/output/cache rates
- `currency`
- effective dates
- source URL/hash

Use a unique key on `(snapshot_id, provider, model_id, usage_mode)`.

### 5.2 Run linkage

Add to the comparison run or immutable run evidence:

- `pricing_snapshot_id`
- `pricing_status`
- `cost_currency`

Do not overwrite the snapshot ID after the run starts.

### 5.3 `eval_llm_request_attempts`

Record one row before and after every outbound LLM generation or judge attempt:

- run/job/request/attempt identity;
- provider, model, endpoint, start/completion timestamps, and latency;
- input, output, total, cached, cache-write, reasoning, and prediction-token fields;
- system/user/assistant prompt token breakdown and prompt character count;
- provider request metadata, cost provenance, status, and sanitized error.

Successful result rows feed cost totals. Attempt rows expose retries and failures without adding their usage a second time.

### 5.3 Usage persistence

Ensure these fields are written for both candidate and judge calls where supplied:

- prompt/input tokens;
- completion/output tokens;
- total tokens;
- cached tokens;
- cache-read and cache-write tokens where supported;
- reasoning tokens where supported;
- provider-reported cost;
- latency;
- provider and model;
- request/attempt identity for retry reconciliation.

## 6. Backend flow

### 6.1 Pricing sync endpoint

Add an admin route:

```text
POST /api/admin/pricing/sync
GET  /api/admin/pricing/status
GET  /api/admin/pricing/snapshots/:snapshotId
```

`POST /pricing/sync` must be idempotent for unchanged source content and must not delete the previous valid snapshot when a provider source fails.

Response must include:

- sync status;
- snapshot ID;
- provider results;
- updated/unchanged/unresolved model counts;
- source timestamps;
- actionable errors.

### 6.2 Start-run flow

Before a run starts:

1. Validate the selected comparison, users, readings, and depths.
2. Resolve the latest valid pricing snapshot.
3. Resolve expected candidate and judge calls.
4. Calculate a no-call estimate from rendered input envelopes and configured output limits or observed history.
5. Show the estimate and assumptions in the confirmation UI.
6. Block paid-cost claims when a selected model has no valid price or usage envelope.
7. Store the pricing snapshot ID with the run.

Starting a run must not call a provider during the estimate step.

### 6.3 Actual run flow

For every candidate and judge attempt:

1. Persist provider/model/request identity.
2. Persist usage and latency as soon as the response is received.
3. Calculate cost from provider cost or the run snapshot.
4. Mark the row `known`, `unknown`, or `partial`.
5. Reconcile retries by attempt ID so one attempt is not counted twice.
6. Preserve completed costs when a run fails or is cancelled.
7. Refuse a successful generation response that contains provider usage but no request artifact; silently incomplete usage is not accepted.

### 6.4 Cost aggregation service

Create one server-side service that returns:

- run summary;
- candidate, primary-judge, and secondary-judge split;
- per-reading rollup;
- per-user rollup;
- per-model rollup;
- token and latency median/p95;
- missing usage and unknown-cost rates;
- estimate-versus-actual variance;
- pricing and usage provenance.

The browser must not calculate authoritative totals from raw JSON.

## 7. API contract

Add:

```text
GET /api/admin/costs/runs/:runId
GET /api/admin/costs/runs/:runId/readings
GET /api/admin/costs/runs/:runId/users
GET /api/admin/costs/estimate?comparisonId=...
```

The main response should have this shape:

```json
{
  "runId": "...",
  "currency": "USD",
  "status": "known|partial|unknown",
  "pricing": {
    "snapshotId": "...",
    "source": "official",
    "fetchedAt": "..."
  },
  "summary": {
    "candidate": { "costUsd": null, "status": "known" },
    "primaryJudge": { "costUsd": null, "status": "known" },
    "secondaryJudge": { "costUsd": null, "status": "unknown" },
    "total": { "costUsd": null, "status": "partial" }
  },
  "byReading": [],
  "byUser": [],
  "warnings": []
}
```

All monetary values must be nullable. `null` plus a reason is safer than zero.

## 8. Dashboard plan

Add a separate **Cost & Usage** navigation item. Keep the existing run report focused on readings and LLM evaluation, but add a compact cost summary and an **Open cost analysis** link.

### 8.1 Page header

- Run selector
- Comparison selector
- Date filter
- Refresh data button
- Pricing snapshot used by the selected run
- Pricing status and last manual sync timestamp

### 8.2 Summary cards

- Total observed cost
- Candidate generation cost
- Primary judge cost
- Secondary judge cost
- Input/output tokens
- Median/p95 latency
- Completed/failed/cancelled cases
- LLM request attempts, retries, failures, and all-attempt token totals

Each card must show `known`, `partial`, `estimated`, or `unknown`.

### 8.3 Cost breakdown

Table columns:

```text
Reading | Depth | Model | Cases | Input tokens | Output tokens |
Median cost | P95 cost | Median latency | P95 latency | Status
```

### 8.4 User breakdown

Table columns:

```text
User | Cases | Candidate cost | Judge cost | Total known cost | Missing usage | Status
```

### 8.5 Cost drivers

Show the largest contributors by:

- model;
- provider;
- reading type/depth;
- user;
- candidate versus judge.

### 8.6 Estimate-versus-actual

Show:

- pre-run estimate;
- actual cost;
- absolute variance;
- percentage variance;
- token and case-count differences;
- assumptions used for the estimate.

### 8.7 Settings pricing panel

Under Reviews & Settings add:

- **Sync official prices** button;
- last successful sync;
- current snapshot ID;
- provider-by-provider status;
- unresolved model count;
- source links;
- failed sync error details;
- available historical snapshots.

## 9. Report integration

The existing run report should display only a compact section:

```text
Cost: $X.XX known / partial
Candidate: $X.XX
Primary judge: $X.XX
Secondary judge: $X.XX
Pricing snapshot: <id>
Open cost analysis
```

The full cost tables remain on the Cost & Usage page to avoid duplicating the report UI.

The LLM evaluation remains expandable and unchanged. Cost must never affect the displayed winner unless the documented quality-and-cost decision policy is explicitly being applied.

## 10. Monthly cost scope

Do not implement a fabricated monthly projection.

When an authoritative production-volume source is available, add a partial monthly view with:

- volume assumptions;
- observed cost per reading/user;
- projected monthly cost;
- per-track contribution;
- confidence and missing-volume warnings.

Until then, show `Unavailable: authoritative production volume is not configured`.

## 11. Security and correctness

- Pricing sync uses public official sources or approved provider metadata only.
- No API secret is written into pricing records or browser responses.
- Admin authorization is required for sync.
- Sync failures retain the last valid snapshot.
- Historical snapshots are immutable.
- Provider/model IDs are validated against the supported model catalog.
- Unknown prices block a “complete paid cost” claim.
- Raw provider errors must not expose secrets.
- Cost calculations use decimal-safe money handling and round only for display.

## 12. Test plan

### Unit tests

- Standard input/output cost formula.
- Cache-read and cache-write pricing.
- Provider-reported cost precedence.
- Missing rate returns `unknown`, not zero.
- Missing usage returns `unknown`.
- Median and p95 aggregation.
- Retry attempt deduplication.
- Request-attempt telemetry captures success, failure, retry, latency, and prompt breakdown.
- Failed and cancelled run partial status.
- Historical snapshot selection.
- Estimate performs zero provider calls.

### Integration tests

- Manual sync creates a valid snapshot.
- Failed provider sync preserves the previous valid snapshot.
- Unchanged official source does not create duplicate rates.
- New run stores the latest snapshot ID.
- Old run continues using its original snapshot after a new sync.
- Candidate and judge totals reconcile with the run total.
- User and reading totals reconcile with the run total.
- Current dataset output is not charged as a new generation.

### UI and end-to-end tests

- Admin can open Cost & Usage from navigation.
- Admin can select a run and see cost status.
- Unknown and partial values are visible and understandable.
- Sync button shows progress, success, and failure states.
- Run confirmation displays an estimate before starting.
- Report links to the correct cost page/run.
- Cancelled and failed runs still expose observed cost.
- 100-user dataset page remains available and unchanged.
- A missing pricing snapshot blocks run creation; no unknown-cost run proceeds.

## 13. Delivery order

### Phase A — Usage capture

- Fix candidate and judge usage propagation.
- Add attempt identity and persistence tests.
- Verify existing reports still work.

### Phase B — Pricing snapshots

- Add migration and schema.
- Implement provider pricing adapters.
- Add manual sync/status endpoints.
- Add Reviews & Settings pricing panel.

### Phase C — Cost service and APIs

- Implement authoritative aggregation.
- Add estimates and provenance.
- Add reconciliation and partial-status rules.

### Phase D — Dashboard and report link

- Add Cost & Usage page/navigation.
- Add run-level, reading-level, user-level, and model-level views.
- Add compact report summary.

### Phase E — Verification and release

- Run migrations.
- Run unit, integration, build, and browser checks.
- Validate with a real completed run and a failed/cancelled run.
- Confirm historical snapshot behavior.
- Confirm the 100-user dataset remains present.

## 14. Definition of done

This feature is complete when:

- An operator can manually sync official prices with one button.
- No daily scheduler exists.
- Every run records the price snapshot used.
- Candidate, primary judge, and secondary judge costs are separated.
- Missing prices never become `$0`.
- Dashboard totals reconcile with persisted usage.
- Reports link to the correct cost analysis page.
- Estimates make no provider calls.
- Failed and cancelled runs retain observed cost.
- Historical runs do not change after a later price sync.
- All tests and production builds pass.
