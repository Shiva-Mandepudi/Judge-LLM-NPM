#!/usr/bin/env bash
set -euo pipefail

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

# Private service: never pass --allow-unauthenticated. Invocation is
# restricted to the IAM bindings granted below (the admin console's service
# account and the Cloud Tasks queue's invoker service account).
gcloud run deploy "${_SERVICE}" \
  --image "${_IMAGE}" \
  --region "${_REGION}" \
  --platform managed \
  --no-allow-unauthenticated \
  --min-instances "0" \
  --max-instances "10" \
  --concurrency "20" \
  --cpu "1" \
  --memory "512Mi" \
  --timeout "300" \
  --port "8081" \
  --set-secrets "${_PRODUCTION_SECRETS}" \
  --set-env-vars "${_PRODUCTION_ENV_VARS}"

gcloud run services add-iam-policy-binding "${_SERVICE}" \
  --region "${_REGION}" \
  --member "serviceAccount:${_CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT}" \
  --role "roles/run.invoker"

gcloud run services add-iam-policy-binding "${_SERVICE}" \
  --region "${_REGION}" \
  --member "serviceAccount:${_ADMIN_CALLER_SERVICE_ACCOUNT}" \
  --role "roles/run.invoker"
