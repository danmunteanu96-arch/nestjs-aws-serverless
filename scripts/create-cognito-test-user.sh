#!/usr/bin/env bash
# Creates and confirms a Cognito test user for the auctions API, then fetches a JWT.
#
# Existing dev test user (created 2026-10-16, pool nestjs-aws-serverless-users-dev):
#   username: testuser@example.com
#   password: Test1234!
#   DEV-ONLY throwaway credential — never reuse this password anywhere real.
#
# Usage:
#   ./scripts/create-cognito-test-user.sh                          # creates testuser2@example.com / Test1234!
#   ./scripts/create-cognito-test-user.sh <email> <password>       # custom credentials
#   ./scripts/create-cognito-test-user.sh testuser@example.com 'Test1234!'  # re-fetch token for existing user
#
# The last line of output is the IdToken — paste it into the Postman collection
# variable `accessToken` (mutations POST/PATCH require it).

set -euo pipefail

STACK_NAME="${STACK_NAME:-nestjs-aws-serverless-dev}"
USERNAME="${1:-testuser2@example.com}"
PASSWORD="${2:-Test1234!}"

read -r POOL_ID CLIENT_ID < <(
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs" --output json \
  | python -c "
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

aws cognito-idp sign-up \
  --client-id "$CLIENT_ID" \
  --username "$USERNAME" \
  --password "$PASSWORD" >/dev/null 2>&1 \
  && echo "sign-up: created" \
  || echo "sign-up: skipped (user probably already exists)"

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
