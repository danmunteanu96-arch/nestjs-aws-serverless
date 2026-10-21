# SQS Queue for Winner Notifications

Commit: `182b020`

## Summary

The "bidder won" email is no longer sent inline by the expiration Lambda.
Closing an auction now enqueues a message to a new SQS queue, and a dedicated
SQS-triggered Lambda consumes it and sends the SES email.

Goal: decouple the critical bookkeeping (closing auctions) from the
side effect (email), and replace silent best-effort email failures with
automatic retries plus a dead-letter queue.

## Architecture and Operations

Flow: EventBridge (5 min) → `closeExpiredAuctions` closes auctions →
`SendMessage` to `WinnerNotificationsQueue` → SQS event source mapping invokes
`sendWinnerNotification` → SES `SendEmail` (same HTML template as before).

- Producer (`auction-expiration.service.ts`): injects `SQSClient` instead of
  `SESClient`; after each successful conditional close it enqueues
  `{ auctionId, recipient, title, winningBid }`. Enqueue failures are still
  logged-and-swallowed so notification problems can never fail a close;
  auctions without bids are skipped as before.
- Consumer (`src/modules/notifications/winner-notification.service.ts` +
  `src/winner-notification.ts` handler): owns the SES send and HTML template.
  Unlike the old inline code, errors are **rethrown** — a failed invocation
  makes SQS redeliver the message (visibility timeout 60s), and after
  `maxReceiveCount: 3` it lands in `WinnerNotificationsDLQ` (14-day retention)
  for inspection/replay.
- New resources: `resources/WinnerNotificationsQueueResource.yml` (queue +
  DLQ, tagged Project/Environment/Owner).
- IAM (`iam/AuctionTableIAM.yml`): `AuctionsExpirationRole` lost `ses:SendEmail`
  and gained `sqs:SendMessage` on the queue; new `WinnerNotificationRole` has
  `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on the queue plus
  `ses:SendEmail` with the `ses:FromAddress` condition.
- Config: `WINNER_NOTIFICATIONS_QUEUE_URL` (zod-validated, injected via
  serverless.yml `Ref`; empty locally is tolerated).
- New infra module `src/infrastructure/sqs/sqs.module.ts` mirrors `SesModule`.

## Verification

- `npm test` — 38/38 pass (producer spec rewritten for SQS enqueue incl.
  no-winner skip, missing-URL skip, enqueue-failure tolerance; new consumer
  spec covers multipart email, HTML escaping, and error propagation).
- `npm run lint` — clean.
- `npm run build` — only the pre-existing `src/lambda.ts:38` TS2554 error
  (unrelated, present before this change).
- `npx serverless deploy` — stack updated, `sendWinnerNotification` function
  and queue created.
- E2E: auction created via API with 6-min TTL, bid placed as the bidder
  Cognito user; after the close tick, expiration logs show the enqueue and the
  consumer logs show the send, and the email arrived.

## Operational caveats

- Standard queue = at-least-once: a redelivery can send a duplicate email.
  Acceptable here; if it ever matters, dedupe by `auctionId` (e.g. a
  notification-sent marker in DynamoDB).
- Check the DLQ (`ApproximateNumberOfMessages`) when investigating missing
  winner emails; messages there are failures that exhausted 3 attempts.
- SES sandbox still applies: both sender and recipient identities must be
  verified until production access is granted.
