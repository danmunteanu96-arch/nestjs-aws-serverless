# Winner Email Notifications via AWS SES

Commit: `<short-hash>`

## Summary

**Goal:** when the scheduled expiration Lambda closes an auction, the highest bidder receives a "You won" email via AWS SES.

**How it works, end to end:**

1. A bidder places a bid through `POST /auctions/:id/bids`. The JWT's `email` claim (already exposed by `CurrentUser`) is stored on the DynamoDB item as `highestBidderEmail`, next to the existing `highestBidderId`. Denormalizing at write time avoids a Cognito lookup in the scheduled Lambda.
2. `highestBidderEmail` never appears in API responses (`toAuction` does not map it) — bidder PII stays out of the public API.
3. Every 5 minutes, `closeExpiredAuctions` queries expired ACTIVE auctions via the new `status-endDate-v2-index` GSI, closes them conditionally, and calls `notifyWinner` for each successful close.
4. `notifyWinner` sends a multipart email (HTML part with inline-CSS branded header + plain-text fallback) through SES. The auction title is user input, so it is HTML-escaped before embedding. Sending is best-effort: SES failures are logged and never fail or retry the close. Auctions without bids are skipped.

## Architecture and Operations

- New `SesModule` (`src/infrastructure/ses/ses.module.ts`) provides one shared `SESClient`, mirroring `DynamoDBModule` (region from `AWS_REGION`, `maxAttempts: 3`).
- New dependency: `@aws-sdk/client-ses`.
- New config: `SES_SENDER_EMAIL` (zod-validated, defaults to empty = notifications skipped with a warning; set in `.env` locally and passed via `serverless.yml` provider environment).
- DynamoDB: GSI projections are immutable, so `status-endDate-v2-index` was added with `highestBidderEmail` in its projection. The expiration Lambda queries the v2 index; `AuctionsService` reads still use v1. Removing the legacy `status-endDate-index` is a separate cleanup once nothing references it.
- IAM (`AuctionsExpirationRole`): `ses:SendEmail` on `Resource: '*'`, restricted by `Condition StringEquals ses:FromAddress = $SES_SENDER_EMAIL` — production-style least privilege (recipients are unknowable ahead of time; the sender is controllable). The role also got `dynamodb:Query` on the v2 index ARN.
- SES sandbox: both the sender and every recipient must be verified identities (`aws sesv2 create-email-identity`). Production access removes the recipient requirement; domain verification (DKIM) is the deliverability answer for real deployments.

## Problems Faced and Solutions

1. **Silent skip — no email, no error in logs.** The Lambda read auctions through `status-endDate-index`, whose `INCLUDE` projection did not carry `highestBidderEmail`; the recipient was always empty. Diagnosed by the *absence* of notify logs plus a direct `dynamodb get-item` proving the attribute existed in the table. Fixed by adding the attribute to the projection — via a new versioned index, because:
2. **"Cannot update GSI's properties"** — DynamoDB rejects in-place projection changes. Solution: create `status-endDate-v2-index`, point the Lambda at it, clean up v1 later (zero-downtime migration pattern).
3. **"Cannot read from backfilling global secondary index"** — transient errors while the new GSI backfilled. No code change needed: the conditional close is idempotent, failures are logged, and the next scheduled tick retries naturally.
4. **SES AccessDenied naming the *recipient* identity** — sandbox SES authorizes `SendEmail` against every identity involved, not just the sender. Interim fix listed both identity ARNs; final fix is the production-style `ses:FromAddress` condition above.
5. **Emails landing in Gmail spam** — not a code issue; expected for new sandbox senders. Production answer: verified sending domain with DKIM.
6. **Unit tests could not catch problem 1** — mocks return full items; only the live E2E flow exposed the projection gap. Tests were still added/updated for all new behavior (email on close, no-winner skip, SES failure tolerance, bid-time email storage, HTML escaping).

## Verification

- Jest: 34/34 unit tests passed (`npm test`); new tests watched failing before implementation (TDD).
- Oxlint: 0 warnings/errors. `tsc --noEmit` passes except a pre-existing, unrelated error at `src/lambda.ts:38` (missing `callback` arg on the `Handler` type) left untouched intentionally.
- E2E on AWS (Postman collection): created a 5-minute auction as `testuser@example.com`, placed a bid as `danmunteanu420@gmail.com`, waited for the scheduled tick; CloudWatch shows `Winner notification sent for auction ...` and the multipart email was delivered (initially to Gmail spam).
- `npm audit` reports 27 pre-existing advisories in dev tooling; not addressed in this change.
