# NestJS Production Refactor

## Summary

Organized auctions, health, configuration, HTTP concerns and DynamoDB infrastructure into NestJS modules. Added validated DTOs, OpenAPI, bounded HTTP payloads, Helmet, compression, correlation IDs, safe error responses and metadata-only request logs. Removed unused Nest starter controllers/services and hand-written auction input parsers.

## Architecture and Operations

- Runtime is Node 24.15+, managed with `.nvmrc`; package manager is npm.
- Serverless Framework 4 aligns with `serverless-offline` 14's peer requirement.
- Lambda HTTP and local HTTP share one bootstrap. Expiration uses a minimal Nest application context, separate least-privilege IAM role, one reserved invocation and a five-minute EventBridge schedule.
- CloudFormation preserves deployed GSIs and adds no schema replacement. Legacy unused GSIs remain to avoid an unreviewed external breaking change.
- Production settings: ARM64, 14-day Lambda logs, owner/project/stage tags. Account-level budget alerts and anomaly detection must be configured before production deployment.

## Verification

- Node 24.15 `tsc --noEmit -p tsconfig.json`: passed.
- Node 24.15 Jest with `--experimental-vm-modules`: 23 unit tests and 4 HTTP e2e tests passed.
- NestJS build and Oxlint passed. `serverless.yml`, IAM and table YAML parsed successfully with `js-yaml`.
- `npm audit --omit=dev`: zero production vulnerabilities. Full dev dependency audit reports 27 advisories (20 moderate, 7 high) in Jest/Serverless-esbuild transitive tooling; npm's proposed fixes are major/downgrade changes, so they were not forced.
- Serverless v4's native CLI could not run in the local shell because its launcher resolved the unavailable Node version-manager alias; no deployment was attempted during this refactor.
- Prior AWS deployment failure was caused by editing an existing DynamoDB GSI projection. The production stack currently retains all existing GSIs; index cleanup requires separate phased updates.
- The two legacy dev auctions were backfilled and then deleted at the user's request. The dev table and indexes remain; the table is empty for Postman testing.
- Production account-level Budget/Anomaly Detection, authentication, API throttling and collection pagination remain deployment/product requirements; see `docs/architecture.md`.
