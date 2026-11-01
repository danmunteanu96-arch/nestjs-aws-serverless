# Refactor production-serverless — 29 octombrie 2026

## Starea livrării

Modificările sunt pe branch-ul `production-serverless`, în working tree local, necommitate. Utilizatorul trebuie să revadă și să aprobe explicit orice commit. Nu s-a făcut push sau deploy în cadrul refactorului.

Acest document descrie implementarea, nu o confirmare că aplicația este deja production-ready în AWS.

## Infrastructură

- Stack-ul vechi a fost separat în `infra.yml`, `api.yml` și `edge.yml`.
- `infra.yml` administrează DynamoDB, S3, SQS/DLQ, Cognito, KMS, SNS, buget/anomaly și parametrii SSM.
- `api.yml` administrează cele trei funcții, API Gateway, IAM, EventBridge și opt alarme CloudWatch.
- `edge.yml` administrează CloudFront, WAF, ACM și alias Route53 opțional în `us-east-1`.
- DynamoDB folosește on-demand, PITR implicit în prod și TTL; resursele stateful au politici Retain.
- API Gateway are throttling 100/200; CORS folosește origini exacte și credentials.
- CloudFront are cache dezactivat pentru API, compresie, WAF rate-based + managed SQLi și origin shared secret.

## Securitate și configurație

- Expeditorul SES și secretul edge sunt SecureStrings citite la bootstrap; valorile nu sunt în YAML.
- Cognito are MFA TOTP opțional, politică de parolă și token validity 1h/1h/30d.
- Rolurile Lambda sunt separate și limitate la acțiunile/resursele necesare; excepțiile wildcard sunt documentate.
- Utilitarul de utilizatori Cognito nu mai are email/parolă implicite și folosește noul nume de stack infra.
- Inputul este validat; JWT identity și ownership sunt aplicate server-side.
- S3 rămâne privat, iar URL-ul de citire expiră la 300 secunde cu tip și disposition controlate.

## Runtime și corectitudine

- Toate entry point-urile folosesc JSON logger și correlation ID; metricile business sunt EMF.
- Clienții AWS sunt reutilizați la warm start și distruși idempotent la shutdown.
- `GET /health` verifică efectiv DynamoDB + SQS cu timeout și 503 sanitizat.
- Listele au paginare cursor cu limită 50 implicit/100 maximum.
- PATCH ownership și regulile de bid/close sunt condiții atomice DynamoDB.
- Imaginile sunt validate și convertite prin Sharp la WebP + thumbnail, cu limite de bytes/pixeli.
- La close se setează TTL 90 zile, se șterg derivatele S3 și se păstrează PENDING până la acceptarea SQS.

## Notificări

- SQS batch size 10 și `ReportBatchItemFailures`.
- Payload Zod strict și procesare independentă per record.
- Claim DynamoDB pe `auctionId`, token per worker, lease 60 secunde și tombstone COMPLETED 30 zile.
- SES are timeout, retry tranzitoriu, backoff/jitter și circuit breaker per warm environment.
- Fallback manual în DLQ păstrează body-ul original; sursa este confirmată numai după acceptarea DLQ.
- Duplicatele după COMPLETED sunt ignorate. Cazul SES succes + crash înainte de COMPLETED poate încă produce un retry/email duplicat și este documentat explicit.

## Performanță și operare

- esbuild minify/tree-shaking, AWS SDK extern și layer comun Linux ARM64/glibc.
- Memoriile implicite sunt API 512 MiB, expiration 256 MiB, notification 256 MiB; nu au fost benchmark-uite.
- Scriptul `benchmark-lambda-memory.sh` testează 128/256/512/1024 MiB numai într-un stage `benchmark-*` confirmat și restaurează configurația.
- `verify-deployment-artifacts.sh` verifică integritatea ZIP și limita de 5 MiB per funcție după packaging.
- Alarmele acoperă ambele DLQ-uri, vechimea mesajelor și Errors/Throttles pentru funcțiile async.

## Documentație pentru student

Au fost rescrise README, arhitectura, fluxul SQS, debuggingul și `AWS-YML-CHEATSHEET.md`. Ghidurile includ ordinea deploy-ului, SSM/secrete, paginare, imagini, idempotență, alarme, health/shutdown, DNS/ACM, rollback și studiu AWS Developer.

## Verificări și limite

Quality gate-ul local final trece: Prettier, Oxlint (0 erori/avertismente), TypeScript, 21 suite/104 teste unitare și de contract, 16 teste E2E, build NestJS, audit runtime (0 vulnerabilități), sintaxa scripturilor shell și JSON-ul Postman. `git diff --check` nu raportează erori de whitespace.

`npx sls package --config infra.yml --stage prod` și validarea șablonului prin `aws cloudformation validate-template` trec. Review-ul final a adăugat `EdgeOriginGuard` cu comparație constant-time, politica SNS pentru CloudWatch și restrângerea acțiunilor IAM neutilizate; testele focused au trecut RED→GREEN, 16/16.

Packaging-ul API se oprește la parametrul SSM real `/nestjs-aws-serverless/prod/alerts/topic-arn`, iar edge la `/nestjs-aws-serverless/prod/api/id`. Prin urmare, cele trei ZIP-uri API lipsesc și verificarea lor sub 5 MiB rămâne blocată. Nu au fost introduse fallback-uri false.

Nu au fost validate în AWS: deploy-ul, change set-urile finale, ZIP-urile reale API, certificatul/DNS-ul, livrarea emailurilor, alarmele SNS și benchmark-ul memoriei. Acestea necesită un cont, resurse și costuri controlate, plus date de test izolate.
