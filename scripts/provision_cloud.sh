#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to the Google Cloud project.}"

REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-atlanta-grocery-rescue}"
QUEUE_NAME="${QUEUE_NAME:-pantry-relay-timeouts}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-pantry-relay-runtime}"
TASK_CALLER_SA_NAME="${TASK_CALLER_SA_NAME:-pantry-relay-task-caller}"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
TASK_CALLER_SA="${TASK_CALLER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
TASKS_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
PHOTO_BUCKET="${PHOTO_BUCKET:-${PROJECT_ID}-pantry-relay-photos}"
COORDINATOR_SECRET="${COORDINATOR_SECRET:-pantry-relay-coordinator-token}"
TOKEN_PEPPER_SECRET="${TOKEN_PEPPER_SECRET:-pantry-relay-token-pepper}"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  cloudtasks.googleapis.com \
  iamcredentials.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  bigquery.googleapis.com \
  aiplatform.googleapis.com \
  --project "${PROJECT_ID}"

if ! gcloud iam service-accounts describe "${RUNTIME_SA}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" --project "${PROJECT_ID}" --display-name "Pantry Relay Cloud Run runtime"
fi
if ! gcloud iam service-accounts describe "${TASK_CALLER_SA}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${TASK_CALLER_SA_NAME}" --project "${PROJECT_ID}" --display-name "Pantry Relay Cloud Tasks OIDC caller"
fi

for role in roles/datastore.user roles/cloudtasks.enqueuer roles/bigquery.jobUser roles/aiplatform.user roles/mcp.toolUser roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member "serviceAccount:${RUNTIME_SA}" --role "${role}" --condition=None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "${TASK_CALLER_SA}" --project "${PROJECT_ID}" --member "serviceAccount:${RUNTIME_SA}" --role roles/iam.serviceAccountUser >/dev/null

# Keep BigQuery row access limited to the challenge dataset. Dataset IAM is
# allowlisted in some lab projects, so update its legacy READER ACL instead.
BQ_DATASET="${BQ_DATASET:-a4i_food}"
BQ_ACL_FILE="$(mktemp)"
bq --project_id="${PROJECT_ID}" show --format=prettyjson "${PROJECT_ID}:${BQ_DATASET}" \
  | jq --arg runtime_sa "${RUNTIME_SA}" '
      if any(.access[]?; .role == "READER" and .userByEmail == $runtime_sa)
      then {access, etag}
      else .access += [{"role":"READER","userByEmail":$runtime_sa}] | {access, etag}
      end
    ' > "${BQ_ACL_FILE}"
bq --project_id="${PROJECT_ID}" update --dataset --update_mode=UPDATE_ACL \
  --source="${BQ_ACL_FILE}" "${PROJECT_ID}:${BQ_DATASET}"
rm "${BQ_ACL_FILE}"

if ! gcloud firestore databases describe --database='(default)' --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud firestore databases create --database='(default)' --location="${REGION}" --type=firestore-native --delete-protection --project "${PROJECT_ID}"
fi
if ! gcloud tasks queues describe "${QUEUE_NAME}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud tasks queues create "${QUEUE_NAME}" --location "${REGION}" --project "${PROJECT_ID}"
fi
gcloud tasks queues add-iam-policy-binding "${QUEUE_NAME}" \
  --location "${REGION}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${RUNTIME_SA}" --role roles/cloudtasks.viewer >/dev/null
if ! gcloud storage buckets describe "gs://${PHOTO_BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${PHOTO_BUCKET}" --project "${PROJECT_ID}" --location "${REGION}" --uniform-bucket-level-access
fi
gcloud storage buckets update "gs://${PHOTO_BUCKET}" --lifecycle-file scripts/cloud_storage_lifecycle.json --project "${PROJECT_ID}"
gcloud storage buckets add-iam-policy-binding "gs://${PHOTO_BUCKET}" \
  --member "serviceAccount:${RUNTIME_SA}" --role roles/storage.objectAdmin >/dev/null

if ! gcloud secrets describe "${COORDINATOR_SECRET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  openssl rand -base64 32 | gcloud secrets create "${COORDINATOR_SECRET}" --project "${PROJECT_ID}" --replication-policy automatic --data-file=-
fi
if ! gcloud secrets describe "${TOKEN_PEPPER_SECRET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  openssl rand -base64 48 | gcloud secrets create "${TOKEN_PEPPER_SECRET}" --project "${PROJECT_ID}" --replication-policy automatic --data-file=-
fi
for secret_name in "${COORDINATOR_SECRET}" "${TOKEN_PEPPER_SECRET}"; do
  gcloud secrets add-iam-policy-binding "${secret_name}" --project "${PROJECT_ID}" \
    --member "serviceAccount:${RUNTIME_SA}" --role roles/secretmanager.secretAccessor >/dev/null
done

# Service Usage does not always materialize the Cloud Tasks service identity
# when the API was pre-enabled in a lab project. Generate it explicitly before
# granting the narrowly scoped token-signing permission.
if ! gcloud iam service-accounts describe "${TASKS_SERVICE_AGENT}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  TASKS_IDENTITY_TOKEN="$(gcloud auth print-access-token)"
  curl --fail --silent --show-error --request POST \
    --header "Authorization: Bearer ${TASKS_IDENTITY_TOKEN}" \
    --header "Content-Type: application/json" \
    --data '{}' \
    "https://serviceusage.googleapis.com/v1beta1/projects/${PROJECT_NUMBER}/services/cloudtasks.googleapis.com:generateServiceIdentity" >/dev/null
  unset TASKS_IDENTITY_TOKEN
fi
gcloud iam service-accounts add-iam-policy-binding "${TASK_CALLER_SA}" \
  --project "${PROJECT_ID}" --member "serviceAccount:${TASKS_SERVICE_AGENT}" \
  --role roles/iam.serviceAccountTokenCreator >/dev/null

# The binding can be established before the service exists and is harmless on rerun.
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --member "serviceAccount:${TASK_CALLER_SA}" --role roles/run.invoker >/dev/null 2>&1 || true

echo "Cloud foundation ready: Firestore (default), queue ${QUEUE_NAME}, bucket gs://${PHOTO_BUCKET}"
