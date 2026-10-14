# Architecture

## Runtime

- Node.js `24.15+`, npm 10+, NestJS 12, TypeScript 6.
- One modular Nest application, deployed as AWS Lambda functions with Serverless Framework 4.
- DynamoDB low-level API from AWS SDK v3; no ORM or extra persistence abstraction.

## Source Layout

```text
src/
	config/                     # startup validation and cached ConfigService
	common/                     # global HTTP filter and request logging
	http/                       # shared HTTP bootstrap
	infrastructure/dynamodb/   # shared DynamoDB client provider
	modules/auctions/           # auction API, DTOs, business service and tests
	modules/auctions/expiration # scheduled expiration service and module
	modules/health/             # liveness endpoint
```

`AppModule` composes features. Controllers accept DTOs and delegate. `main.ts` and the API Lambda use the same HTTP bootstrap. The scheduled Lambda uses a minimal Nest application context so it does not initialize HTTP controllers.

## HTTP Contract

- `GET /health`: cheap liveness check; does not depend on DynamoDB.
- `GET /auctions`: active and closed auctions, including `endDate`; optional `?status=ACTIVE` or `?status=CLOSED` filters by status (case-insensitive).
- `GET /auctions/active`: active auctions ordered by `endDate`.
- `GET /auctions/:id`, `POST /auctions`, `PATCH /auctions/:id`, `POST /auctions/:id/bids`.
- `GET /docs` and `/docs-json` are enabled outside production by default. Set `API_DOCS_ENABLED=true` to enable them explicitly in production.
- Bodies use runtime DTO validation, transformation, unknown-field rejection and a 1 MiB limit. IDs must be UUIDs.
- Errors use `{ statusCode, message, path, requestId }`. Unexpected 500 responses do not expose provider messages. `x-request-id` is validated or generated and returned in responses/logs.
- CORS is closed unless comma-separated origins are supplied in `CORS_ORIGINS`. No credentials are enabled.

## Auction Expiration

The EventBridge rule invokes the expiration Lambda every five minutes. It queries `status-endDate-index` for `ACTIVE` rows with `endDate <= now`, then conditionally sets each row to `CLOSED`. Updates are idempotent, run at a bounded concurrency of 10, and the Lambda has reserved concurrency 1. Expected close delay is up to five minutes after the deadline plus GSI propagation.

The existing `status-endDate-index` supports active lists, all-status lists and expiry processing. Other previously deployed GSIs remain in CloudFormation for compatibility, but application code no longer queries them. Remove legacy indexes only through a separately reviewed, phased CloudFormation change; DynamoDB allows only one GSI create/delete operation per table update.

## Configuration

`ConfigModule` validates configuration once at startup and caches values. `AUCTIONS_TABLE` is required except in tests, `AWS_REGION` defaults to `eu-central-1`, and `PORT` defaults to `3000`. See `.env.example`. AWS credentials use the standard SDK credential chain; never put credentials in `.env.example`.

The shared DynamoDB client uses three bounded SDK attempts. API and expiration functions have separate IAM roles. The expiration role can query only the deadline index and update the table. CloudWatch log retention is 14 days, Lambda defaults to ARM64, and resources are tagged with project, stage and owner.

## Operations and Costs

- Before production deployment, configure an AWS Budget alert and Cost Anomaly Detection in the account. These require account-specific thresholds and notification destinations and are not created by this application stack.
- Set `RESOURCE_OWNER` and `CORS_ORIGINS` for the target deployment. Set `DYNAMODB_PITR_ENABLED=true` for production backups; PITR is disabled by default to avoid development cost.
- Import `postman/Auctions.postman_collection.json` to exercise the API and wait through the five-minute expiration interval.
- This learning API currently has no authentication or API Gateway throttling, and collection reads are unpaginated. Add these before exposing it to untrusted production clients or large data volumes.
- The dev table is currently empty after the requested test-data cleanup. Create fresh records with Postman before exercising auction routes.
- `npm audit --omit=dev` is clean. The dev toolchain currently has 27 transitive advisories (7 high) in Jest/Serverless-esbuild dependencies; automatic major/downgrade fixes were deliberately not applied.
