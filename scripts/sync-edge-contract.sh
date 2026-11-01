#!/usr/bin/env bash
# =============================================================================
# scripts/sync-edge-contract.sh
#
# Purpose: copy the API Gateway id from the regional API stack (eu-central-1)
# to the edge stack's region (us-east-1).
#
# Why: SSM parameters are regional. api.yml writes /nestjs-aws-serverless/<stage>/api/id
# in eu-central-1, but edge.yml reads the same path in us-east-1 to build the
# CloudFront origin domain. Without this mirror, `sls package --config edge.yml`
# fails with "Cannot resolve ${ssm:.../api/id}".
#
# Usage:
#   ./scripts/sync-edge-contract.sh [stage]     # default: prod
#
# Cost: SSM standard String parameters are free at this scale.
# Safety: writes only this non-secret identifier; it never reads or prints secrets.
# =============================================================================
set -euo pipefail

STAGE="${1:-${STAGE:-prod}}"
SOURCE_REGION="${SOURCE_REGION:-eu-central-1}"
EDGE_REGION="${EDGE_REGION:-us-east-1}"
PARAMETER="/nestjs-aws-serverless/${STAGE}/api/id"

for command_name in aws; do
  command -v "$command_name" >/dev/null || {
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  }
done

API_ID="$(aws ssm get-parameter \
  --name "$PARAMETER" \
  --region "$SOURCE_REGION" \
  --query 'Parameter.Value' \
  --output text)"

if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  printf 'No API id found at %s in %s. Deploy api.yml first.\n' "$PARAMETER" "$SOURCE_REGION" >&2
  exit 1
fi

aws ssm put-parameter \
  --name "$PARAMETER" \
  --value "$API_ID" \
  --type String \
  --overwrite \
  --region "$EDGE_REGION" >/dev/null

printf 'Mirrored %s=%s from %s to %s. Deploy edge.yml next.\n' \
  "$PARAMETER" "$API_ID" "$SOURCE_REGION" "$EDGE_REGION"
