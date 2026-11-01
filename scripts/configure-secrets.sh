#!/usr/bin/env bash
# =============================================================================
# scripts/configure-secrets.sh
#
# Writes the two runtime secrets directly to SSM Parameter Store as SecureString
# values. The values are never echoed, logged or written to a repository file.
#
# Required environment:
#   STAGE              prod (or another deployed stage)
#   SES_SENDER_EMAIL   a verified SES identity in the deployment region
#   EDGE_SHARED_SECRET a random value of at least 24 characters
# Optional:
#   AWS_REGION         default eu-central-1
#   EDGE_AWS_REGION    default us-east-1 (CloudFront/Lambda@Edge reads it there)
#   SSM_KMS_KEY_ID     optional customer-managed key for the SSM parameters
#
# Why two regions? The API reads the secure parameter in eu-central-1; the
# Lambda@Edge origin function reads its copy in us-east-1.
#
# Cost: SSM Standard parameters are free at this scale; PutParameter calls are
# negligible. Rotating the edge secret requires a Lambda config update/redeploy
# so warm execution environments read the new value.
# =============================================================================
set -euo pipefail

# Writes secrets directly to SSM without printing or persisting them locally.
: "${STAGE:?Set STAGE to the deployment stage}"
: "${SES_SENDER_EMAIL:?Set SES_SENDER_EMAIL to a verified SES sender}"
: "${EDGE_SHARED_SECRET:?Set EDGE_SHARED_SECRET to a long random value}"
AWS_REGION="${AWS_REGION:-eu-central-1}"
# CloudFront reads the same SecureString from us-east-1; API reads its regional copy.
EDGE_AWS_REGION="${EDGE_AWS_REGION:-us-east-1}"
SSM_PREFIX="${SSM_PREFIX:-/nestjs-aws-serverless/${STAGE}}"

encryption_args=()
if [[ -n "${SSM_KMS_KEY_ID:-}" ]]; then
  encryption_args=(--key-id "${SSM_KMS_KEY_ID}")
fi

aws ssm put-parameter \
  --name "${SSM_PREFIX}/secrets/ses-sender-email" \
  --value "${SES_SENDER_EMAIL}" \
  --type SecureString --overwrite \
  --region "${AWS_REGION}" "${encryption_args[@]}"

aws ssm put-parameter \
  --name "${SSM_PREFIX}/secrets/edge-shared-secret" \
  --value "${EDGE_SHARED_SECRET}" \
  --type SecureString --overwrite \
  --region "${AWS_REGION}" "${encryption_args[@]}"

aws ssm put-parameter \
  --name "${SSM_PREFIX}/secrets/edge-shared-secret" \
  --value "${EDGE_SHARED_SECRET}" \
  --type SecureString --overwrite \
  --region "${EDGE_AWS_REGION}" "${encryption_args[@]}"

unset SES_SENDER_EMAIL EDGE_SHARED_SECRET
printf 'SecureString parameters updated under %s; values were not displayed.\n' "${SSM_PREFIX}"
