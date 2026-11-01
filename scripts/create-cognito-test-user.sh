#!/usr/bin/env bash
# =============================================================================
# Creates and confirms a disposable Cognito test user, then fetches its JWT.
#
# Usage:
#   TEST_USER_PASSWORD='...' ./scripts/create-cognito-test-user.sh <email>
#   ./scripts/create-cognito-test-user.sh <email> <password>   # visible in history
#
# Use a unique password that you do not reuse for any real account. Prefer the
# TEST_USER_PASSWORD environment variable so the password is not in shell
# history. If the user already exists, the script resets its password with the
# admin API, so a fresh IdToken can always be issued. The last output line is a
# one-hour IdToken for the Postman variable.
#
# STACK_NAME defaults to the dev infra stack; for prod use:
#   STACK_NAME=nestjs-aws-serverless-infra-prod ...
#
# Cost: Cognito users and sign-ins are free at this volume. The script calls
# CloudFormation and Cognito APIs only; it creates no billable infrastructure.
# =============================================================================

set -euo pipefail

STACK_NAME="${STACK_NAME:-nestjs-aws-serverless-infra-dev}"
USERNAME="${1:?Provide a disposable test email as argument 1}"
# Prefer TEST_USER_PASSWORD so the password does not appear in shell history.
PASSWORD="${2:-${TEST_USER_PASSWORD:-}}"
: "${PASSWORD:?Provide a disposable test password as argument 2 or TEST_USER_PASSWORD}"

PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || command -v python || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  printf 'Python 3 is required to read the CloudFormation outputs.\n' >&2
  exit 1
fi

read -r POOL_ID CLIENT_ID < <(
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs" --output json \
  | "$PYTHON_BIN" -c "
import json, sys
outs = {o['OutputKey']: o['OutputValue'] for o in json.load(sys.stdin)}
print(outs['CognitoUserPoolId'], outs['CognitoUserPoolClientId'])
"
)
# strip CR from Windows line endings (Git Bash)
POOL_ID="${POOL_ID%$'\r'}"
CLIENT_ID="${CLIENT_ID%$'\r'}"

echo "User Pool: $POOL_ID"
echo "Client:    $CLIENT_ID"
echo "User:      $USERNAME"

if aws cognito-idp sign-up \
  --client-id "$CLIENT_ID" \
  --username "$USERNAME" \
  --password "$PASSWORD" >/dev/null 2>&1; then
  echo "sign-up: created"
else
  # Existing users cannot sign up again. Reset their password with the admin
  # API so a known TEST_USER_PASSWORD can be used to fetch a fresh IdToken.
  echo "sign-up: skipped (user exists); resetting password"
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$POOL_ID" \
    --username "$USERNAME" \
    --password "$PASSWORD" \
    --permanent >/dev/null
  echo "password: reset"
fi

aws cognito-idp admin-confirm-sign-up \
  --user-pool-id "$POOL_ID" \
  --username "$USERNAME" 2>/dev/null \
  && echo "confirmed: $USERNAME" \
  || echo "confirm: skipped (already confirmed)"

echo "--- IdToken (valid 1h) ---"
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters "USERNAME=$USERNAME,PASSWORD=$PASSWORD" \
  --query "AuthenticationResult.IdToken" \
  --output text
