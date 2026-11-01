# HANDOFF — 2026-11-01

## State

- Branch `production-serverless`; this file describes the state before the final snapshot commit.
- AWS account `205952665307`; **all project resources were deleted on 2026-11-01**. No live URL, no stacks, no S3/DynamoDB/SQS/Cognito/CloudFront/API Gateway/Lambda.
- The only remnants are non-billable: SES identities, the pre-existing `Zero-Dollar-Limit` budget and `Default-Services-Subscription`, the IAM admin user, the default VPC and AWS-managed KMS keys.
- The branch is a Serverless Framework snapshot; the next step is migrating the application to **AWS CDK**.
- Benchmark results and live evidence are historical, in `docs/deployment-report.md`.

## Decisions

- Cost-safe defaults: PITR off (`DYNAMODB_PITR_ENABLED=true` opts in), no customer KMS, no WAF, no custom domain, logs 7 days, S3 lifecycle 1 day multipart / 7 days noncurrent.
- Lambda memory kept at **512 / 256 / 256 MiB**: measured benchmark showed 128 MiB cheapest per invocation, but 512 gives the API a 2.85s cold start and 3–4ms warm, and notification peaked near 139 MB at 256. Differences are micro-cents.
- CloudFront origin protection uses a **Lambda@Edge origin-request** function that reads the SecureString from SSM and adds `x-auctions-edge-key`; CloudFormation rejects `ssm-secure` directly in CloudFront Origins.
- `/api/id` is mirrored from `eu-central-1` to `us-east-1` by `scripts/sync-edge-contract.sh` because SSM is regional.

## Verification

- 106/106 unit/contract tests, 16/16 E2E, typecheck/lint/build/Prettier clean, artifact verifier passes.
- CloudFront `/health` → 200; direct API → 403; unauthenticated POST → 401; CORS exact origin.
- Two full auctions created/bid/closed through CloudFront; SES logs show `Winner notification sent`; S3 images removed; idempotency `COMPLETED`.
- Duplicate SQS delivery produced two `WinnerNotificationDuplicate` metrics and no second email.
- Benchmark CSV: `benchmark-results/benchmark-1-20261101T115241Z-5869/summary.csv`.
- Cost Explorer at first check: $0.00; budget alert $5 (80% = $4); benchmark added micro-cent invocations.

## Remaining user action

1. **Confirm the SNS email** sent to the configured alert address. It is `PendingConfirmation`; AWS deletes it after 48 hours if unconfirmed.
2. SNS drift: the old subscription expired but CloudFormation still tracks it; the new one was created manually. Do not run an `infra.yml` update with a changed `ALERT_EMAIL` without repairing `OpsAlertsEmailSubscription` (details in `docs/deployment-report.md`).
3. Postman: `baseUrl` is set. Fresh IdTokens are in `/tmp/creator.token` and `/tmp/bidder.token` (about 1 hour); for a later run, use `scripts/create-cognito-test-user.sh` with `TEST_USER_PASSWORD` (it resets an existing user's password).

## Docs

- `docs/aws-learning-guide.md` — how the YAML, code, SSM contract and AWS services fit together; cost and teardown.
- `docs/deployment-report.md` — live evidence, defects found/fixed, benchmark table.
- `README.md`, `docs/architecture.md`, `DEBUGGING-GUIDE.md`, `SQS-FLOW-EXPLAINED.md`, `AWS-YML-CHEATSHEET.md` — updated.
- New helper: `scripts/sync-edge-contract.sh`.
