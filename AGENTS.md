# NestJS Agent Rules — Production-Ready Defaults

> **Purpose:** These are operating rules for an AI coding agent building or modifying a NestJS application. Apply them to new and existing codebases. They are deliberately framework-wide, not specific to one product or database.
>
> **Keywords:** **MUST** = default requirement; **SHOULD** = preferred unless a concrete reason says otherwise; **WHEN NEEDED** = introduce only when the application has that requirement. Keep the solution as small as possible while meeting production requirements.

## 0. Highest-priority rules

1. **Inspect before changing.** Read `package.json`, the lockfile, `tsconfig`, lint/test/build scripts, `main.ts`, `app.module.ts`, and the relevant feature module. Match the installed NestJS major version and existing conventions. Do not assume APIs, defaults, or package compatibility from a different version.
2. **Preserve working architecture.** Make the smallest complete change that solves the task. Do not rewrite the app, change ORM/framework, or add a new architecture pattern without a specific reason.
3. **Verify, do not merely generate.** Run the narrowest relevant tests, then lint/type-check/build as available. Report commands actually run and any failures; never claim unrun checks passed.
4. **Prefer boring, supported technology.** Use NestJS primitives and actively maintained dependencies. Before adding/upgrading a package, verify its current maintenance status, compatibility, security advisories, and version support.
5. **No speculative complexity.** Do not add CQRS, event sourcing, microservices, a message broker, Redis, a generic repository framework, custom decorators, or extra layers unless there is a real use case.

## 1. Application structure

- **MUST organize by feature/domain**, not by global technical folders alone. Each meaningful feature owns its controller, application/business logic, DTOs, and data-access code as appropriate.
- **MUST use Nest modules as boundaries.** A module owns its providers. Export only providers that form its public interface; import the owning module where needed. Avoid making everything `@Global()` just to save imports.
- **SHOULD default to a modular monolith.** One deployable application with explicit feature modules is the default. Split deployables/services only for independent scaling, deployment, security, ownership, or reliability needs.
- **SHOULD start with a simple feature layout**, for example:

  ```text
  src/
    main.ts
    app.module.ts
    common/                 # truly cross-cutting code only
      filters/
      interceptors/
      decorators/
      guards/
    config/
    infrastructure/         # shared infrastructure adapters when justified
    modules/
      <feature>/
        <feature>.module.ts
        <feature>.controller.ts
        <feature>.service.ts # or use-case/application services if warranted
        dto/
        persistence/         # when this feature owns persistence concerns
  test/
  ```

- **MUST keep `AppModule` as composition/configuration**, not a home for business logic.
- **MUST keep controllers thin:** parse the HTTP contract, rely on pipes/guards, call application logic, and return a defined result. No business rules or handwritten SQL in controllers.
- **MUST put business rules in services/use cases/domain code**, not in controllers, interceptors, DTOs, or ORM hooks.
- **SHOULD use application/domain/infrastructure layers only where they improve isolation or testing.** Do not force every CRUD feature into four layers and ten files.
- **MUST avoid circular dependencies.** Revisit module ownership and interfaces before using `forwardRef()`; treat it as an exception, not a normal design tool.
- **MUST keep shared code genuinely generic.** Do not place feature-specific logic in `common/`. Avoid dumping unrelated utilities in a `shared` module.

## 2. Dependency injection and TypeScript

- **MUST use constructor injection** for dependencies. Use injection tokens for interfaces/ports because TypeScript interfaces do not exist at runtime.
- **SHOULD declare return types on public service methods and non-obvious functions.** Keep strict TypeScript checks enabled when the project allows it.
- **MUST avoid `any`, unsafe casts, non-null assertions, and `@ts-ignore`** unless necessary at an external boundary; isolate and explain any such escape hatch.
- **MUST handle promises explicitly.** Await operations whose failure/result matters; do not leave floating promises in request paths or background handlers.
- **MUST avoid request-scoped providers by default.** They can increase lifecycle/latency overhead. Use them only when request-specific DI state is genuinely needed; prefer explicit parameters or request context mechanisms.
- **MUST not use `ModuleRef` as a general service locator.** Use normal DI; reserve dynamic lookup for justified plugin/lifecycle cases.
- **SHOULD keep DTOs, persistence models, domain types, and response contracts distinct** when their responsibilities or fields differ. Avoid leaking ORM entities directly as public API contracts.

## 3. Global HTTP pipeline: configure deliberately

Configure cross-cutting behavior centrally and consistently. Prefer providers registered with Nest tokens (`APP_*`) when dependency injection is required.

### 3.1 Bootstrap and configuration

- **MUST validate configuration at startup** and fail fast when required environment variables are missing or malformed. Use `@nestjs/config` with a schema/validator suitable for the repo.
- **MUST keep secrets out of source control, logs, tests, and committed example files.** Supply them through the target environment/secret manager.
- **MUST use one documented configuration path** (`ConfigService` or an established typed config layer); do not scatter `process.env` reads through feature logic.
- **SHOULD configure a global API prefix and API versioning only if needed by clients/deployment policy.** Do not introduce breaking version machinery without a contract requirement.
- **MUST define CORS explicitly for browser-facing APIs.** Use environment-specific allowed origins; do not blindly use `*` with credentials.
- **MUST configure security headers** using the supported Nest API for the installed version or the adapter-appropriate Helmet package. Verify CSP and proxy behavior for the actual application.
- **MUST set reasonable payload/file size limits and request/time limits** at the application or hosting boundary when supported; do not allow unbounded user-controlled inputs.
- **SHOULD expose health/readiness endpoints appropriate to the deployment.** Keep liveness cheap; readiness may check essential dependencies. Do not make an external dependency outage cause a liveness restart loop.

### 3.2 Global validation

- **MUST validate every untrusted input at the boundary**: body, query, params, headers where relevant, uploaded file metadata, and external/webhook payloads.
- **SHOULD use a global `ValidationPipe`** with `transform: true`, `whitelist: true`, and usually `forbidNonWhitelisted: true`; adjust only for a documented API compatibility reason.
- Use DTO **classes** with runtime validation decorators for `class-validator`-based validation. TypeScript interfaces/types alone do not provide runtime validation metadata.
- **MUST validate semantic/business constraints too.** DTO validation does not replace authorization, database constraints, uniqueness checks, or business invariants.
- **MUST not trust client-supplied IDs, ownership, roles, prices, status fields, or audit fields.** Derive trusted identity and controlled fields server-side.
- **SHOULD keep separate DTOs for create/update/query operations** when constraints or permitted fields differ. Use partial/mapped DTO helpers only when they preserve the intended contract.

### 3.3 Global error handling

- **MUST provide one consistent, documented HTTP error contract.** Use a global exception filter only when the built-in Nest handling is insufficient or a standard error format is required.
- When a custom filter is used, **register it with `APP_FILTER`** if it needs DI; `app.useGlobalFilters(new ...)` outside a module is not appropriate for filters that require injected providers.
- **MUST preserve correct HTTP status semantics.** Map validation/auth/not-found/conflict/rate-limit/dependency failures deliberately; do not turn every exception into `400` or `500`.
- **MUST never return stack traces, SQL, environment values, secrets, or internal exception details to clients in production.** Keep safe diagnostic details in server logs, correlated by request/trace ID.
- **MUST not silently swallow errors.** If catching an error to translate or add context, preserve its cause where supported and rethrow/map it. Avoid redundant `try/catch` blocks that only rethrow unchanged.
- **MUST distinguish expected domain failures from unexpected faults.** Use Nest HTTP exceptions or typed application errors, with a central mapping policy where that improves consistency.
- **MUST not use both a global interceptor and a global filter to independently format the same error response.** Filters own exception-to-HTTP mapping; interceptors may observe/log errors but must preserve error propagation.

### 3.4 Global request logging and correlation

- **SHOULD install a global logging/observability interceptor** using `APP_INTERCEPTOR` if request lifecycle logs and timing are required. Registering via `APP_INTERCEPTOR` allows normal DI.
- Record structured fields such as request/correlation ID, method, matched route (not raw untrusted URL if it might contain secrets), response status, duration, and safe actor identifier if relevant.
- **MUST log failures as well as successes.** Ensure the interceptor's error/finalization path handles exceptions; a success-only `tap()` does not log thrown errors.
- **MUST propagate or generate a correlation ID** and include it in error responses/logs. Trust incoming correlation headers only according to a defined policy; validate/replace arbitrary values and prevent log injection.
- **MUST redact secrets and sensitive data.** Never log Authorization/Cookie headers, passwords, tokens, full request/response bodies, payment data, or unnecessary personal data. Log selected fields, not whole objects.
- **SHOULD use structured JSON logs in production.** Nest's logger is a valid baseline; adopt a maintained structured logger such as Pino only when it meets actual operational needs. Use the same logging contract throughout the app.
- **Do not use an interceptor as the only logging mechanism** for Lambda invocations, scheduled jobs, queue consumers, bootstrap, or code paths outside the HTTP request pipeline. Instrument those entry points separately.
- **MUST keep the request pipeline responsibilities separate:** middleware for adapter-level request setup, guards for access decisions, pipes for validation/transformation, interceptors for cross-cutting handler behavior/timing, filters for exception-to-response mapping.

## 4. API and data contracts

- **MUST design predictable HTTP semantics:** correct status codes, stable field names, consistent pagination, and documented request/response schemas.
- **MUST publish/update OpenAPI documentation** for public or team-consumed HTTP APIs using `@nestjs/swagger` (or the project's equivalent). Keep auth requirements, DTO validation, error responses, and examples accurate.
- **MUST define response DTOs/shapes** and avoid exposing password hashes, secrets, internal flags, persistence-only columns, or unapproved fields.
- **SHOULD use pagination for collection endpoints.** Enforce sensible maximum page sizes. Prefer cursor/keyset pagination for large or frequently changing datasets when offset pagination becomes expensive or unstable.
- **MUST validate sort/filter fields against an allowlist.** Never interpolate arbitrary client strings into SQL/order-by expressions.
- **MUST handle empty, missing, invalid, and boundary values intentionally.** Avoid relying on implicit JavaScript coercion for public API behavior.
- **WHEN NEEDED**, introduce idempotency keys for client retries, payment-like operations, webhook processing, and commands where duplicate execution has consequences.
- **WHEN NEEDED**, use explicit API versioning/deprecation policy where clients cannot all deploy together.

## 5. Persistence and transactions

- **MUST choose persistence technology based on data shape and access patterns**, not because a template happens to use it. Use a maintained ORM/query builder or parameterized SQL; each has trade-offs.
- **MUST use migrations** for schema evolution in shared/test/staging/production environments. Do not rely on `synchronize: true` or ORM auto-schema mutation in production.
- **MUST enforce durable invariants in the database too** where possible: primary/foreign keys, unique constraints, check constraints, and non-null constraints. Application validation alone cannot protect concurrent requests.
- **MUST use transactions** when multiple database changes must succeed or fail as one operation. Keep the transactional boundary explicit and avoid network calls inside long-running DB transactions.
- **MUST prevent SQL injection** through parameterized queries or safe ORM APIs. Never concatenate untrusted input into SQL.
- **SHOULD select only needed columns, avoid N+1 queries, index actual query patterns, and measure slow queries.** Do not add indexes blindly; account for write/storage cost.
- **SHOULD define a consistent pagination and transaction strategy per feature.** Use optimistic/pessimistic concurrency controls where concurrent updates can violate invariants.
- **MUST configure connection pools/timeouts/retries for the deployment model.** In serverless environments specifically, account for concurrent function instances and DB connection limits; do not create an unbounded pool per invocation.
- **MUST translate persistence errors safely.** Return useful client-level errors for known cases (for example, unique conflict) without exposing raw database errors.
- **WHEN NEEDED**, use an outbox or durable queue when a database commit and event delivery must remain consistent. Do not assume a DB transaction also makes a remote API/message publish atomic.

## 6. Authentication and authorization

- **MUST make access policy explicit and default-deny for protected operations.** Each protected handler must require authentication and the correct authorization rule.
- **MUST separate authentication (who is the caller?) from authorization (may they do this?).** Use Guards/policies/metadata appropriate to the use case; do not bury authorization checks in controllers inconsistently.
- **MUST check resource ownership/tenant boundaries** on every operation involving user-owned resources. A valid JWT alone does not authorize access to an arbitrary resource ID.
- **SHOULD make public endpoints explicit** through a well-defined public-route decorator/metadata mechanism if auth is global; test that protected endpoints cannot accidentally become public.
- **MUST use established, maintained authentication libraries or a trusted identity provider** instead of inventing cryptographic/token protocols. Verify token signature, issuer, audience, expiry, and allowed algorithms as appropriate.
- **MUST hash passwords with a suitable password-hashing algorithm and current parameters**; never encrypt/store plaintext passwords or use a fast general-purpose hash.
- **MUST protect browser cookie-based authentication against CSRF** and set appropriate Secure/HttpOnly/SameSite attributes. Do not store bearer tokens or secrets in logs.
- **MUST use least privilege** for roles, cloud IAM, database credentials, and service accounts. Never use an administrator credential for ordinary application operations.
- **MUST apply rate limiting to sensitive/high-abuse routes**, especially login, password reset, token issuance, search endpoints vulnerable to scraping, and expensive operations. Choose storage that works across replicas if distributed consistency matters; in-memory limits alone are per process.

## 7. Reliability, async work, and external services

- **MUST set timeouts** on outbound HTTP/database/SDK operations when the client supports them. A request should not hang indefinitely.
- **MUST bound retries and use backoff/jitter** for transient failures. Do not retry non-idempotent operations blindly or retry permanent errors.
- **MUST assume external services and queues can time out or deliver duplicates.** Make consumers idempotent where duplicate processing is possible.
- **SHOULD use a queue/worker** for long-running, retryable, or non-request-critical work (email, image processing, bulk operations) instead of holding the user request open. Introduce a queue only when the requirement justifies its operational cost.
- For Redis-backed queues, prefer the currently maintained Nest integration for **BullMQ** rather than starting new work on Bull when both satisfy the requirement.
- **MUST handle partial failure explicitly.** Document what happens if the DB commit succeeds but notification/remote delivery fails.
- **SHOULD implement graceful shutdown/cleanup** for persistent servers, DB pools, queue workers, and test environments. Follow platform-specific lifecycle behavior rather than blindly applying server shutdown patterns to serverless functions.

## 8. Security and privacy

- **MUST treat all external input as untrusted**, including query strings, headers, uploaded files, webhooks, messages, environment variables, and data read from third-party services.
- **MUST avoid mass assignment.** Map allowed DTO fields explicitly; never pass arbitrary body objects straight into an ORM create/update operation.
- **MUST configure CORS, security headers, payload limits, rate limits, and authentication intentionally.** These are distinct protections; one does not replace another.
- **MUST protect file uploads** with size/type limits, safe generated names, storage outside executable paths, and malware/content inspection when the threat model requires it.
- **MUST validate webhook authenticity** using the provider's documented signature/timestamp scheme and protect against replay where relevant.
- **MUST keep PII and credentials out of logs and telemetry**, and define retention/access controls appropriate to the system.
- **SHOULD use dependency auditing and automated security checks in CI** where supported; resolve critical/high issues or document a deliberate exception.

## 9. Testing and CI quality gates

- **MUST add tests for every meaningful behavior change**, including failure paths and boundary conditions—not just happy paths.
- **Unit tests** cover business rules and service/use-case behavior with dependencies mocked only where appropriate.
- **Integration tests** cover database mappings, constraints, transactions, queue adapters, and external boundaries that mocks cannot prove. Use isolated test infrastructure where practical.
- **E2E tests** cover critical API flows through routing, validation, authentication/authorization, error mapping, and response contracts.
- **MUST test authorization negatives** (anonymous caller, wrong role, wrong owner/tenant), invalid DTOs, expected error statuses, and duplicate/concurrent operations when relevant.
- **SHOULD keep tests deterministic**: isolate data, avoid depending on execution order or live third-party services, and clean up created resources.
- **CI SHOULD fail on** formatting/lint violations, TypeScript/build errors, unit/integration/e2e tests selected for the pipeline, and relevant dependency/security checks.
- **MUST not weaken/remove tests merely to make a change pass.** If a test exposes a contract change, update tests only when the intended behavior actually changed.

## 10. Performance and cost

- **Measure before optimizing.** Identify the hot path and use traces/profiling/load tests before adding caching or changing adapters.
- **MUST avoid blocking CPU-heavy work on the event loop** in request handlers. Use workers/queues or an appropriate compute boundary for heavy work.
- **SHOULD keep network calls and DB operations parallel only when they are independent**, and bound concurrency when fan-out could overload downstream services.
- **MUST apply limits** to pagination, search complexity, regex/input size, uploads, batch sizes, and expensive external calls.
- **WHEN NEEDED**, cache expensive, frequently reused data with an explicit TTL, invalidation strategy, and acceptable staleness. Do not add a cache without a consistency plan.
- **Use Express by default unless a measured requirement favors Fastify.** Fastify can be faster, but adapter-specific plugins and middleware differ; benchmark the real application and verify compatibility before switching.
- **Avoid unnecessary request-scope DI, repeated initialization, duplicate serialization, and large payloads.** Profile rather than guessing.

## 11. AWS/Lambda-specific rules (apply only when this is the deployment target)

- **MUST keep application/bootstrap initialization reusable across warm invocations** where the chosen adapter/runtime permits it. Do not rebuild the Nest application for every request. Do not store user/request-specific mutable state in module-level variables.
- **MUST understand the event adapter boundary.** If using an Express/Fastify adapter to forward API Gateway events to Nest, do not add Lambda middleware that parses/transforms the same HTTP event unless it is proven compatible; avoid double parsing/error handling.
- **MUST account for Lambda concurrency when sizing database connections** and set connection/time limits. Evaluate RDS Proxy or a suitable serverless database access pattern based on measured connection pressure, not as a ritual.
- **SHOULD use AWS Lambda Powertools or an equivalent maintained observability library** for structured Lambda logs, metrics/tracing, correlation, and idempotency where useful. Add only the packages/features needed.
- **MUST use least-privilege IAM** scoped to the required resources and actions. Keep separate stages/accounts/resources as appropriate; avoid wildcard permissions when resource scoping is possible.
- **MUST set and test function memory/timeout using measurements.** More memory may increase CPU and reduce duration; the cheapest memory value is not necessarily the lowest cost per successful request.
- **MUST make asynchronous event handlers idempotent** and design around duplicate delivery/retries. Never assume exactly-once delivery.
- **MUST define data-retention/deletion and backup/recovery policies** for persistent resources; a development stack's destructive cleanup policy must not silently apply to production.
- **SHOULD use infrastructure as code and repeatable CI/CD** for infrastructure and application changes. Review the synthesized/deployed resources and run smoke tests after deployments.
- **MUST not add Middy to an HTTP Nest application just because it runs on Lambda.** Use it only for a concrete Lambda-handler middleware requirement, particularly when handling events directly rather than through Nest's HTTP pipeline.

## 12. Dependency and framework choices

- Prefer Nest's built-in abstractions first: modules/providers, guards, pipes, interceptors, filters, `ConfigModule`, testing tools, and OpenAPI integration.
- Prefer **one** solution per concern (one main logger, one validation strategy, one error contract, one ORM per bounded app) rather than overlapping frameworks.
- Use a database library that fits the project's SQL/control, team familiarity, migrations, runtime, and deployment requirements. Do not impose Prisma, TypeORM, MikroORM, Drizzle, or MongoDB on every app.
- Add a cache, queue, search engine, scheduler, or telemetry SDK only with a defined requirement and operating plan.
- **MUST not blindly copy a boilerplate.** Treat templates as evidence of proven patterns, then select the minimum subset suitable for this codebase. Validate repository activity, supported versions, license, and transitive dependencies.

## 13. Mandatory workflow for every agent task

1. **Understand:** inspect relevant files, tests, package versions, established patterns, and the user's exact acceptance criteria.
2. **Plan narrowly:** identify the behavior to change, files likely involved, invariants, failure paths, and the tests required. For trivial tasks, do this internally without a long plan in chat.
3. **Implement minimally:** follow feature boundaries and global conventions; do not mix unrelated refactors into the change.
4. **Verify:** run targeted tests first, then applicable lint/typecheck/build/e2e checks. Inspect the final diff for accidental changes, secrets, unsafe casts, dead code, duplicate logic, and missing negative tests.
5. **Report honestly:** summarize behavior changed, important design decisions, checks run and their actual results, plus any unverified risks or required environment setup.
6. **Never claim production readiness from code generation alone.** Production readiness requires the relevant tests, deployment configuration, security controls, observability, operational recovery, and environment-specific validation.

## 14. Definition of done

A task is complete only when all applicable conditions are met:

- [ ] Follows existing module ownership and conventions; no unjustified architectural expansion.
- [ ] Public input is validated and authorization is enforced where required.
- [ ] Expected failures map to correct status/error contract; unexpected errors do not leak internals.
- [ ] Sensitive values are not exposed in response, logs, test fixtures, or committed config.
- [ ] Database writes/transactions and async side effects preserve required invariants and handle retries appropriately.
- [ ] Automated tests cover the new behavior and relevant failure cases.
- [ ] Relevant lint, type-check, tests, and build have been run or explicitly marked as not run.
- [ ] API docs/configuration/deployment assets are updated where the behavior requires it.
- [ ] The diff is minimal, understandable, and free of unrelated changes.

## 16. Cost efficiency on AWS (mandatory when AWS is the target)

- MUST set AWS Budget alerts and cost anomaly detection before deploying.
- MUST tag every resource with project/env/owner. Untagged resources are unauditable.
- MUST configure CloudWatch Logs retention explicitly (7–14 days app, 90 days audit).
  NEVER leave "Never expire".
- MUST default to arm64 (Graviton) for Lambda, Fargate, RDS, ElastiCache when compatible.
- MUST enable response compression (Brotli/gzip) for JSON APIs.
- SHOULD prefer API Gateway throttling over in-memory rate limiting on Lambda.
- SHOULD measure cold start before choosing Lambda. For steady traffic, a small
  Fargate/App Runner container may be cheaper than Lambda + RDS Proxy + provisioned concurrency.
- MUST NOT enable Aurora Serverless v2 min ACU > 0.5 without measured justification.
- MUST NOT add RDS Proxy, Redis, or a message broker without a measured problem they solve.
- SHOULD tier tests: unit+integration on PR, smoke e2e on merge, full e2e nightly.
  Do not run full e2e on every commit.
- SHOULD use Lambda Powertools EMF for custom metrics instead of PutMetricData.
- MUST log only metadata in production. Never log bodies, headers, or PII.
  Use sampling for high-volume endpoints.
- SHOULD use CloudFront in front of API Gateway for public APIs to reduce
  data transfer and cache static responses.
- MUST configure log levels per environment. `debug` never runs in production.

