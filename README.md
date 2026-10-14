# Auctions API

NestJS 12 API and scheduled auction worker running on AWS Lambda, API Gateway, EventBridge and DynamoDB.

## Requirements

- Node.js 24.15 or later in the 24.x line (`.nvmrc` pins the version)
- npm 10 or later
- AWS credentials via the standard AWS SDK credential chain for deployment and DynamoDB access

## Setup

```bash
nvm install 24.15.0
nvm use 24.15.0
npm ci
```

On Windows with nvm-windows, run `nvm install 24.15.0` and `nvm use 24.15.0`; that tool does not automatically read `.nvmrc`.

For local HTTP development, copy `.env.example` to `.env` and set `AUCTIONS_TABLE` to a table you can access. Never put AWS credentials in `.env`.

```bash
npm run start:dev
npm test
npm run test:e2e
npm run typecheck
npm run lint
```

## API

The local API listens on `PORT` (default `3000`). Routes are documented at `/docs` outside production. The liveness endpoint is `GET /health`.

Auction routes: `GET /auctions`, `GET /auctions/active`, `GET /auctions/:id`, `POST /auctions`, `PATCH /auctions/:id`, and `POST /auctions/:id/bids`.

New auctions require an ISO 8601 `endDate`. Active auctions are closed by an EventBridge-triggered Lambda every five minutes. See [docs/architecture.md](docs/architecture.md) and import [postman/Auctions.postman_collection.json](postman/Auctions.postman_collection.json) for details.

## Deployment

Configure `RESOURCE_OWNER` and `CORS_ORIGINS` for the target stage, then run:

```bash
npm exec serverless -- deploy --stage dev
```

Before production deployment, configure an AWS Budget alert and Cost Anomaly Detection in the AWS account. See [docs/architecture.md](docs/architecture.md) for AWS resources, IAM scopes, migrations and operational notes.
