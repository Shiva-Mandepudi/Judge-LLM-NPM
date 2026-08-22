# Judge-LLM Service

A private, internal microservice that evaluates cheaper models, prompt changes, batch generation, and cached content for Cosmic Guidance — **without ever touching production traffic**. It never charges credits, creates users, mutates subscriptions, or writes user-facing content, and it never runs inline with a normal user request.

This service is completely separate from `CosmicGuidance/`. It has its own database, its own deploy pipeline, and its own Cloud Run service. Cosmic Guidance exposes the private HMAC-authenticated generation/calculation boundary described below; the current live adapter is limited to numerology.

## Architecture

```
Admin / operator                     Cosmic Guidance
      |                                        ^
      | (admin shared secret)                  | (HMAC-signed internal API call —
      v                                         |  implemented private route)
+---------------------------+                   |
|  Judge Service (Cloud Run,|-------------------+
|  private, no public       |
|  ingress)                 |------> Cloud Tasks queue --> Judge Service /internal/worker
|                           |         (OIDC-authenticated push)
|  - experiments/datasets   |
|  - judge providers        |------> Anthropic (primary judge) / OpenAI (secondary judge)
|  - stats/decision engine  |
|  - human review queue     |
|  - audit log              |
+---------------------------+
      |
      v
  Judge's own Postgres DB (JUDGE_DATABASE_URL) — never CG's product DB
```

### Data flow for one evaluation job

1. An admin creates an **experiment** (track, dataset, baseline/candidate model + prompt version) via `POST /api/admin/experiments`.
2. `enqueueExperimentJobs` fans the experiment out into one **job** per dataset case and dispatches each asynchronously via Cloud Tasks (or inline in local dev).
3. The Cloud Tasks push handler (`/internal/worker/run-job`, OIDC-verified) calls `runJob`, which:
   - Calls Cosmic Guidance's internal evaluation-generation interface twice (baseline arm, candidate arm) with the dataset case's de-identified input snapshot.
   - Runs **deterministic checks** (schema validity, numerology/date consistency, safety keyword screen) on each arm's output.
   - Randomly, blindly assigns the two arms to labels A/B (`assignBlindLabels`) so the judge never learns which label is baseline.
   - Calls the **primary judge** (always) and, for a config-sampled fraction of jobs, the **secondary cross-vendor judge**, both with a JSON-schema-forced response (dimension scores per label, hard-gate pass/fail per label, pairwise winner, confidence).
   - Persists every generation, deterministic result, and judge score row, and enqueues a **human review** item on hard-gate failure, judge disagreement, or low confidence.
4. Once enough jobs are `completed`, `POST /api/admin/experiments/:id/compute-results` aggregates all completed jobs into per-dimension means, win/tie/loss rate, judge agreement rate, and a `pass | hold | rollback` **recommendation** — which is advisory only; nothing in this service ever writes to production model configuration.

## Repository layout

```
judge-service/
  shared/            contract types, config schema, rubric, judge JSON-schema (shared between server code and scripts)
  server/
    auth/            admin shared-secret + Cloud Tasks OIDC verification
    config/          admin-managed versioned config (models, thresholds, sample rates)
    providers/       Anthropic / OpenAI / mock judge provider clients
    services/        dataset, generation-client, deterministic-checks, blind A/B, judge-client,
                      scoring, agreement, stats, decision, human-review, audit, experiment, results
    workers/          job-runner (one job end to end), Cloud Tasks client
    routes/           experiments, admin, worker (Cloud Tasks push target), health
  admin-dashboard/    static read-only dashboard (experiments, results, review queue)
  datasets/<track>/<version>/cases.jsonl   versioned synthetic datasets, one dir per track
  migrations/0001_init.sql                 Judge's own Postgres schema
  test/unit, test/integration, test/e2e    see "Testing" below
```

## Database

The Judge service owns its **own** Postgres database (`JUDGE_DATABASE_URL`), completely separate from Cosmic Guidance's product DB. No table here has a foreign key into a Cosmic Guidance user/profile/subscription/credit/conversation/reading row — only opaque case identifiers and de-identified input snapshots.

Tables (see `migrations/0001_init.sql` / `shared/schema.ts`):
`eval_datasets`, `eval_dataset_cases`, `eval_config_versions`, `eval_experiments`, `eval_jobs`, `eval_generations`, `eval_deterministic_results`, `eval_judge_scores`, `eval_human_review_queue`, `eval_results_summaries`, `eval_audit_log`, `eval_idempotency_keys`.

Apply the migration with `psql "$JUDGE_DATABASE_URL" -f migrations/0001_init.sql`, or `npm run db:push` (drizzle-kit push) against `shared/schema.ts`.

## Configuration — nothing hardcoded

Every model name, provider, threshold, sample rate, and cost rate is **admin-managed config**, stored versioned in `eval_config_versions` and published via `POST /api/admin/config`. Nothing in code names a specific model or price. See `shared/config-schema.ts` for the full shape. Example publish payload:

```json
{
  "configKey": "global",
  "value": {
    "providers": {
      "primary_judge": { "provider": "anthropic", "model": "<your-chosen-model>", "secretRef": "ANTHROPIC_API_KEY" },
      "secondary_judge": { "provider": "openai", "model": "<your-chosen-model>", "secretRef": "OPENAI_API_KEY" }
    },
    "secondaryJudgeSampleRate": 0.2,
    "costRatesUsdPer1kTokens": { "<model-name>": { "promptPer1k": 0.0, "completionPer1k": 0.0 } },
    "thresholds": { "maxSoftDimensionDegradation": 0.3, "minWinPlusTieRate": 0.6, "minJudgeAgreementRate": 0.7 }
  }
}
```

`secretRef` is a Secret Manager resource name in production, or a bare env var name in local dev (resolved by `server/lib/secrets.ts`, mirroring Cosmic Guidance's own `resolveSecretFromEnvOrFile` convention).

## Local setup

```bash
cd judge-service
npm install
cp .env.example .env        # fill in JUDGE_DATABASE_URL etc.

# 1. Start a local Postgres (or use Docker):
docker run -d --name judge-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=judge_llm -p 55432:5432 postgres:16-alpine

# 2. Apply the schema:
psql "postgres://postgres:postgres@localhost:55432/judge_llm" -f migrations/0001_init.sql

# 3. Validate the seed datasets (no DB needed):
npm run datasets:validate

# 4. Typecheck + build:
npm run check
npm run build

# 5. Run tests (unit tests need no DB; integration/e2e need JUDGE_DATABASE_URL pointed at the Postgres above):
npm run test:unit
JUDGE_DATABASE_URL=postgres://postgres:postgres@localhost:55432/judge_llm npm run test:integration
JUDGE_DATABASE_URL=postgres://postgres:postgres@localhost:55432/judge_llm npm run test:e2e

# 6. Run the service itself (LOCAL_INLINE_WORKER=true in .env.example avoids needing Cloud Tasks locally):
npm run dev
```

## Creating and running an experiment (local, mocked)

With `LOCAL_INLINE_WORKER=true`, no Cloud Tasks/GCP setup is needed:

```bash
# 1. Publish a config (see above) with providers set to "mock" for a fully offline run,
#    or real "anthropic"/"openai" providers with real API keys.
curl -X POST localhost:8081/api/admin/config -H "x-judge-admin-secret: $JUDGE_ADMIN_SHARED_SECRET" -H "content-type: application/json" -d @config.json

# 2. Register a dataset version:
curl -X POST localhost:8081/api/admin/datasets/register -H "x-judge-admin-secret: $JUDGE_ADMIN_SHARED_SECRET" -H "content-type: application/json" \
  -d '{"track":"numerology","version":"v1"}'

# 3. Create an experiment:
curl -X POST localhost:8081/api/admin/experiments -H "x-judge-admin-secret: $JUDGE_ADMIN_SHARED_SECRET" -H "content-type: application/json" \
  -d '{"name":"numerology mini-model test","track":"numerology","datasetId":"<id from step 2>","baselineModel":"<model>","candidateModel":"<model>","baselinePromptVersion":"LifePath_Brief_Prompt.md","candidatePromptVersion":"LifePath_Brief_Prompt.md"}'

# 4. Enqueue jobs (runs inline immediately in local dev):
curl -X POST localhost:8081/api/admin/experiments/<experimentId>/enqueue -H "x-judge-admin-secret: $JUDGE_ADMIN_SHARED_SECRET"

# 5. Compute results:
curl -X POST localhost:8081/api/admin/experiments/<experimentId>/compute-results -H "x-judge-admin-secret: $JUDGE_ADMIN_SHARED_SECRET"

# 6. View in the dashboard:
open http://localhost:8081/admin/dashboard
```

`test/e2e/full-experiment.test.ts` runs exactly this lifecycle programmatically against `test/mock-cosmic-guidance.ts` (a local stand-in implementing the contract in `shared/contract.ts`) and the `mock` judge provider — no GCP or real model API needed.

## Connecting Cosmic Guidance

Cosmic Guidance implements the internal endpoints specified in `shared/contract.ts`. The current production allow-list contains only the numerology adapter; the other evaluator tracks remain fixtures until their adapters are added:

- `POST /api/internal/judge/generate` — accepts `{track, arm, model, promptVersion, inputSnapshot, requestId}`, authenticated via an HMAC signature (`x-judge-timestamp` + `x-judge-signature` headers, shared secret in Secret Manager — see `server/services/generation-client.ts` for the exact signing scheme this service already sends). It must:
  - Reuse the **existing** prompt builder / schema validator / calculator for the given track (e.g. `dynamic-insights-service.ts`, `numerologyInsightService.ts`, `natalChartInsightService.ts`, `ai-contextual-chat.ts`'s `buildContextualPromptFromTemplate`) — never a duplicate.
  - Run in an evaluation mode that **never** charges credits, creates users, mutates subscriptions, or writes to `readings`/`conversations`/My Day caches — a pure generate-and-return.
  - Return deterministic calculation outputs verbatim from CG's own calculators (`deterministic-calculator.ts`, `numerology-service.ts`, etc.) when relevant, never leave the Judge service to invent them.
  - Never require or return PII, auth tokens, PII-vault ciphertext, or unnecessary user identifiers.
- `POST /api/internal/judge/calc-snapshot` — used only by `scripts/generate-synthetic-datasets.ts` to refresh datasets from real calculators for new synthetic subjects.

Local tests can still use `test/mock-cosmic-guidance.ts`; production requests use the private HMAC-authenticated Cosmic Guidance routes and never fall back to invented data.

## GCP deployment

1. Create the Judge service's own Cloud SQL Postgres instance (or a separate database on an existing instance) and a `JUDGE_DATABASE_URL` secret in Secret Manager.
2. Create the remaining secrets referenced in `cloudbuild.yaml`'s `_PRODUCTION_SECRETS`: `JUDGE_ADMIN_SHARED_SECRET_REF`, `JUDGE_TO_CG_SHARED_SECRET_REF`, `COSMIC_GUIDANCE_INTERNAL_BASE_URL`, `JUDGE_WORKER_OIDC_AUDIENCE`, `JUDGE_WORKER_URL`, `CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`.
3. Create a Cloud Tasks queue (`gcloud tasks queues create judge-eval-jobs --location=<region>`) with its own retry config (matches this service's `retryPolicy` config for consistency, but Cloud Tasks' queue-level retry is the actual enforcement layer).
4. Create a dedicated service account for Cloud Tasks to invoke the worker (`CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT`) and one for the admin console/CI caller (`_ADMIN_CALLER_SERVICE_ACCOUNT` substitution in `cloudbuild.yaml`).
5. Run the Cloud Build trigger (`cloudbuild.yaml`). It typechecks, validates datasets, runs unit tests, builds the image, and deploys with **`--no-allow-unauthenticated`** — this service must never be public — then grants `roles/run.invoker` to the two service accounts above.
6. Publish an initial admin config (`POST /api/admin/config`) before running any real experiment; the service refuses to run judge calls against an unconfigured provider.

## Security decisions

- **Two independent auth layers** on every path: Cloud Run IAM (`--no-allow-unauthenticated`, only bound service accounts can invoke at all) plus application-level checks (`x-judge-admin-secret` shared secret for the admin API, Cloud Tasks OIDC token verification — including service-account-identity check, not just signature validity — for the worker endpoint).
- Outbound calls to Cosmic Guidance are HMAC-signed with a timestamp to prevent replay, using a Secret Manager-resolved shared secret (never hardcoded, never logged).
- All Judge LLM provider API keys are resolved through `secretRef` values in admin config, never embedded in code or committed config.
- Idempotency: every job has a unique `idempotency_key`; Cloud Tasks task names are derived from it (safe re-enqueue), and `eval_idempotency_keys` plus a job-status check in the worker route prevent double-processing a completed job.
- Retries: `generation-client.ts` retries 5xx/429 with exponential backoff (config-driven), never retries 4xx.
- Structured JSON logging only, no PII fields anywhere in this service's schema or logs (see `shared/contract.ts`'s doc-comment on what Cosmic Guidance must never send).
- Full audit trail (`eval_audit_log`) on every experiment/job/config/dataset/human-review mutation, with the prompt version, model, and config version in effect at the time.

## Scalability decisions

- Cloud Run scales the admin API and worker from the same stateless image; jobs are distributed via Cloud Tasks so a burst of experiment creation doesn't overload any single instance.
- Rate limiting is in-memory/per-instance (`server/lib/rate-limit.ts`, explicitly marked `ponytail:` with its upgrade path) since this is an internal batch tool with no Redis/Memorystore per the requirements — acceptable slight over-admission across instances during a burst, not acceptable for a user-facing limiter.
- No secondary judge call unless the config's `secondaryJudgeSampleRate` selects the job (deterministic hash-based sampling, reproducible across retries) — keeps the expensive cross-vendor check to the sampled fraction only.

## Testing

- `npm run test:unit` — deterministic checks, stats/decision logic, agreement, blind A/B assignment. No external dependencies.
- `npm run test:integration` — config versioning, dataset registration idempotency, admin/Cloud-Tasks auth (403/401 paths), generation-client retry/non-retry behavior. Requires `JUDGE_DATABASE_URL`.
- `npm run test:e2e` — the full experiment lifecycle (dataset → experiment → jobs → mocked generation → deterministic checks → dual mock-judge scoring → stats → decision) against `test/mock-cosmic-guidance.ts`. Requires `JUDGE_DATABASE_URL`.
- `npm run datasets:validate` — schema-validates every `datasets/<track>/<version>/cases.jsonl` file and prints its checksum.

All 25 tests pass locally (9 unit-in-isolation + 4 additional unit + 11 integration + 1 e2e = 25); `npm run check` (tsc, strict mode) and `npm run build` (esbuild) both succeed. This service has no separate linter, matching Cosmic Guidance's own tooling convention (`tsc` is the enforced check there too).

## Known limitations / remaining manual configuration

- **Live track coverage is intentionally partial** — the internal interface is implemented, but only the numerology adapter is currently allow-listed. Add future tracks by reusing their existing prompt builder, schema validator, and calculator rather than duplicating them here.
- Rate limiting is per-instance in-memory (documented above); upgrade to a DB-backed limiter if cross-instance precision starts to matter.
- Borderline non-inferiority results surface as `recommendation: "hold"` on the results summary (visible in the admin dashboard) rather than as a row in `eval_human_review_queue`, since a borderline result is a property of the aggregate experiment, not a single job — per-job triggers (hard-gate failure, judge disagreement, low confidence) do enqueue individual review-queue rows.
- The admin dashboard is a single static read-only page (experiments, latest results, pending review queue); resolving a human-review item or publishing config must currently be done via the API directly (documented above), not a dashboard form.
- No separate secondary Cloud Run service was created for the worker; the same service handles both the admin API and the Cloud Tasks push target behind path-based routing (`/api/admin/*` vs `/internal/worker/*`), each with its own auth middleware — simpler to operate than two services for this scale, revisit if worker and admin traffic need independent scaling policies.
- Numerology's 100%-exhaustive protocol and the annual Personal Year refresh (framework doc §5) are supported structurally (dataset can contain all 142 cases; nothing samples), but no scheduler is wired up to trigger the annual re-run automatically — that's an operational cron to add when the calendar need arises.
