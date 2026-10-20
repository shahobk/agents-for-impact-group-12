#!/usr/bin/env bash
set -euo pipefail

# Deploy the one-service public hackathon demo after provision_cloud.sh.

: "${PROJECT_ID:?Set PROJECT_ID to the Google Cloud project to deploy into.}"

REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-atlanta-grocery-rescue}"
PUBLIC_ACCESS="${PUBLIC_ACCESS:-true}"
ENABLE_BIGQUERY_MCP="${ENABLE_BIGQUERY_MCP:-true}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-pantry-relay-runtime@${PROJECT_ID}.iam.gserviceaccount.com}"
TASK_CALLER_SERVICE_ACCOUNT="${TASK_CALLER_SERVICE_ACCOUNT:-pantry-relay-task-caller@${PROJECT_ID}.iam.gserviceaccount.com}"
TASKS_QUEUE="${TASKS_QUEUE:-pantry-relay-timeouts}"
COORDINATOR_SECRET="${COORDINATOR_SECRET:-pantry-relay-coordinator-token}"
TOKEN_PEPPER_SECRET="${TOKEN_PEPPER_SECRET:-pantry-relay-token-pepper}"

if [[ "${PUBLIC_ACCESS}" == "true" ]]; then
  AUTH_FLAG="--allow-unauthenticated"
else
  AUTH_FLAG="--no-allow-unauthenticated"
fi

gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  "${AUTH_FLAG}" \
  --service-account "${RUNTIME_SERVICE_ACCOUNT}" \
  --concurrency 40 \
  --set-secrets "COORDINATOR_TOKEN=${COORDINATOR_SECRET}:latest,TOKEN_PEPPER=${TOKEN_PEPPER_SECRET}:latest" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},GOOGLE_GENAI_USE_VERTEXAI=true,ENABLE_BIGQUERY_MCP=${ENABLE_BIGQUERY_MCP},WORKFLOW_REPOSITORY=firestore,DEMO_MODE=true,WORKFLOW_MATCHER_ENABLED=true,WORKFLOW_DEMO_FALLBACK=false,CLOUD_TASKS_QUEUE=${TASKS_QUEUE},CLOUD_TASKS_LOCATION=${REGION},CLOUD_TASKS_SERVICE_ACCOUNT=${TASK_CALLER_SERVICE_ACCOUNT}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

# The service URL is assigned by the first deployment. Update the revision once
# with the exact callback and OIDC audience used by Cloud Tasks.
gcloud run services update "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --update-env-vars "CLOUD_TASKS_CALLBACK_URL=${SERVICE_URL}/internal/tasks/advance-offer,TASK_OIDC_AUDIENCE=${SERVICE_URL}"

gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --member "serviceAccount:${TASK_CALLER_SERVICE_ACCOUNT}" \
  --role roles/run.invoker >/dev/null

echo "Pantry Relay deployed: ${SERVICE_URL}"
