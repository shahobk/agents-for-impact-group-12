#!/usr/bin/env bash
# Deploy the Resilient Food Equity & Surplus Broker ADK Agent (and optional MCP Toolbox) to Google Cloud Run.
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-food-surplus-broker-agent}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "your-gcp-project-id" ]]; then
  echo "ERROR: Please set GOOGLE_CLOUD_PROJECT or run 'gcloud config set project YOUR_PROJECT_ID' first."
  exit 1
fi

echo "================================================================"
echo "Deploying ADK Agent to Cloud Run"
echo "  Project : ${PROJECT_ID}"
echo "  Region  : ${REGION}"
echo "  Service : ${SERVICE_NAME}"
echo "================================================================"

# Deploy the ADK agent with the web UI and min-instances=1 to avoid cold-start delays during demo
adk deploy cloud_run \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --service_name="${SERVICE_NAME}" \
  --with_ui \
  agent

