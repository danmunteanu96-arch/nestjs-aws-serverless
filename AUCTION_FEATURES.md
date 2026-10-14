# Auction Features

## Features

- Auctions require an ISO 8601 `endDate`; dates are normalized to UTC. Updates can change the deadline.
- `GET /auctions/active` returns active auctions ordered by ending date. `GET /auctions` returns both statuses with their end dates; `GET /auctions/:id` returns the individual auction.
- An EventBridge schedule runs every five minutes. Its Lambda adapter boots a minimal NestJS module; `AuctionExpirationService` queries expired active auctions and conditionally changes them to `CLOSED`. Expected close delay is up to five minutes after the deadline.
- `npm run migrate:auction-end-dates` previews a seven-day (`createdAt + 7 days`) backfill. Add `-- --apply` to update records missing `endDate`.
- Import `postman/Auctions.postman_collection.json` for the API test flow. Create an auction, then wait until its deadline plus up to five minutes before running the auto-close check.

## AWS and Deployment

Serverless Framework v3 resolves `serverless.yml` and imports the DynamoDB table and IAM role from `resources/AuctionTableResource.yml` and `iam/AuctionTableIAM.yml`. CloudFormation manages the table, GSIs, Lambda functions, IAM role, and EventBridge schedule. The `status-endDate-index` uses `status` as its partition key and `endDate` as its sort key. The existing GSIs are preserved.

The expiration Lambda uses the AWS SDK v3 DynamoDB client through the NestJS `DynamoDBModule`. Its minimal `AuctionExpirationModule` avoids initializing HTTP controllers. No packages were added.

## Checks and Deployment Notes

- Passed: `npm exec tsc -- --noEmit -p tsconfig.json`, `npm run lint`, `npm exec serverless -- print --stage dev`, and `git diff --check`.
- Jest could not run under local Node 20: Jest's CommonJS runtime could not load the ESM `@nestjs/common` package. The isolated expiration test passed before the service was moved into Nest dependency injection.
- First deploy failed because DynamoDB does not allow changing an existing GSI projection. The fix preserves the old indexes and adds `status-endDate-index` as a new index. CloudFormation reached `UPDATE_COMPLETE`; the new index was verified `ACTIVE`.
- While DynamoDB was backfilling the new index, `GET /auctions` returned 500 with `Cannot read from backfilling global secondary index`. It returned `200 []` after the index became active and the dev auctions were cleared.
- The seven-day migration was dry-run, then applied to two legacy auctions in `nestjs-aws-serverless-auctions-dev`. Those two auction records were later deleted at the user's request; the table and indexes remain.
- Serverless v3 warns that it does not recognize the configured `nodejs24.x` runtime, although packaging and deployment completed. Local Node was 20.18.0.