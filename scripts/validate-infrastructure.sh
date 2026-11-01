#!/usr/bin/env bash
# =============================================================================
# scripts/validate-infrastructure.sh
#
# Packages infra.yml locally, then asks CloudFormation to validate the
# synthesized template. It does NOT create or update a stack.
#
# Usage: ./scripts/validate-infrastructure.sh [stage]
#
# Requires: npx/Serverless and AWS credentials. Cost: validate-template is free.
# =============================================================================
set -euo pipefail

# Packages and validates CloudFormation locally/remotely without creating a stack.
STAGE="${1:-dev}"
npx sls package --config infra.yml --stage "${STAGE}"
aws cloudformation validate-template \
  --template-body "file://.serverless/cloudformation-template-update-stack.json" \
  --region "${AWS_REGION:-eu-central-1}"
