# Raport de deployment — 2026-11-01

Acest raport descrie ce a fost verificat efectiv în AWS, ce a rămas nevalidat și ce trebuie să facă utilizatorul. Nu înlocuiește documentația de arhitectură; o completează cu dovezi.

> **Istoric:** toate resursele AWS ale proiectului au fost șterse la 2026-11-01 după verificare. URL-ul, stack-urile și resursele din acest raport nu mai există. Branch-ul este un snapshot Serverless Framework înainte de migrarea pe AWS CDK.

## 1. Mediu

| Element | Valoare |
|---|---|
| Cont AWS | `205952665307` (nu conține secrete) |
| Regiune aplicație | `eu-central-1` |
| Regiune edge | `us-east-1` |
| Stage | `prod` |
| URL public (la testare, acum inactiv) | `https://d1sik11s5f836g.cloudfront.net` |
| API Gateway id | `5r5dl3yrg7` |
| CloudFront distribution | `E1H8D8PG7QCLUE` |

Stack-uri active:

- `nestjs-aws-serverless-infra-prod` — `CREATE_COMPLETE`
- `nestjs-aws-serverless-api-prod` — `UPDATE_COMPLETE`
- `nestjs-aws-serverless-edge-prod` — `CREATE_COMPLETE`

## 2. Calitate locală

| Verificare | Rezultat |
|---|---|
| Teste unitare + contracte | **106/106** |
| Teste E2E HTTP | **16/16** |
| Typecheck | PASS |
| Oxlint | 0 erori / 0 warnings |
| Build NestJS | PASS |
| `verify-deployment-artifacts.sh` | 3 ZIP-uri valide, < 5 MiB |

## 3. Verificări live

### API și edge

| Verificare | Rezultat |
|---|---|
| `GET /health` prin CloudFront | **200** `{"status":"ok","checks":{"dynamodb":"up","sqs":"up"}}` |
| `GET /health` direct la API Gateway, fără header | **403** |
| `POST /auctions` fără JWT | **401** |
| CORS preflight `http://localhost:3000` | **204**, `access-control-allow-origin` exact, `allow-credentials: true` |
| CORS cu origine neaprobată | fără `access-control-allow-origin` |
| `GET /docs` în prod | **404** (Swagger dezactivat) |
| CloudFront WebACL | gol (WAF nu a fost creat) |
| Certificat | CloudFront default (`CloudFrontDefaultCertificate: true`) |
| ACM / Route 53 | niciun certificat / nicio hosted zone create |

### Fluxul de business

| Pas | Rezultat |
|---|---|
| Creator diferit de bidder | da |
| Create multipart cu imagine | **201**, `status=ACTIVE`, `imageUrl` prezent |
| Actualizare de către bidder | **403** |
| Bid de către creator | **403** |
| Bid de către bidder | **201**, `currentBid=25` / `40` |
| Imagine servită prin URL semnat | **200**, conținut `RIFF...WEBP` |
| Obiecte S3 create | `image.webp` + `thumbnail.webp` |
| După `endDate` | `CLOSED`, fără `imageKey`, fără `imageUrl` |
| Obiecte S3 curente după close | 0 (rămân versiuni non-current, expirate de lifecycle în 7 zile) |
| Email SES | log `Winner notification sent` pentru ambele licitații |
| Idempotență | item `COMPLETED` pentru ambele licitații |
| Duplicate SQS | 2 mesaje → 2 metrici `WinnerNotificationDuplicate`, niciun al doilea email |
| DLQ winner | 0 mesaje |
| DLQ expiration | 0 mesaje |
| Alarme CloudWatch | toate cele 8 `OK` |

## 4. Defecte găsite și reparate în timpul verificării

1. **`ERR_REQUIRE_ESM`** — NestJS 12 este ESM-only, bundle-ul era CommonJS. Fix: `format: esm`, `outputFileExtension: '.mjs'`, `forceEsm: true`, plus importuri `.js` pentru subpath-uri.
2. **Handler callback-style** — Node 24 Lambda a eliminat handler-ele cu `callback`. Fix: handler async cu `(event, context)`.
3. **Secret încărcat prea târziu** — `ConfigModule.forRoot` valida env la import, înainte ca `loadRuntimeConfig()` să citească SSM. Fix: import dinamic al grafului Nest după încărcarea secretelor.
4. **`OriginProtocolPolicy` poziționat greșit** — trebuie sub `CustomOriginConfig`; altfel CloudFormation respinge distribuția.
5. **`ssm-secure` în CloudFront Origins** — neacceptat de CloudFormation. Fix: Lambda@Edge `origin-request` citește SecureString-ul și adaugă header-ul.
6. **`ExpressionAttributeNames` incomplete** — `complete`/`release` foloseau `#completedAt`, `#expiresAt`, `#leaseExpiresAt` fără să le declare; DynamoDB returna `ValidationException`, iar mesajul ajungea în DLQ. Fix: toate numele declarate + test de regresie care verifică fiecare placeholder.

## 5. Costuri

- Cost Explorer pentru 2026-11-01, la prima verificare: **0 USD** (o singură interogare, cost API $0.01). Benchmark-ul a adăugat invocări de ordinul micro-centurilor; verifică Billing pentru valoarea finală.
- Buget configurat: **5 USD**, alertă la 80% (4 USD). Alerta nu oprește cheltuielile.
- Profil: fără WAF, KMS customer-managed, PITR, ACM, Route 53, NAT, EC2, RDS sau provisioned concurrency.
- Logs: 7 zile; S3: lifecycle 1 zi multipart / 7 zile non-current; DynamoDB: TTL.
- Benchmark: stage disposable, șters imediat; rezultatele sunt în `benchmark-results/` local.

## 6. Ce rămâne de făcut

- **SNS:** subscripția la adresa de alertă configurată este `PendingConfirmation`. Confirmă emailul în maximum 48 de ore; altfel AWS o șterge.
- **Drift SNS:** subscripția veche a expirat și CloudFormation încă o are în stare. Subscripția nouă este creată manual. Nu rula un update `infra.yml` cu `ALERT_EMAIL` schimbat fără să repari întâi resursa; un update fără `ALERT_EMAIL` ar încerca să șteargă subscripția/bugetul condiționat. Pentru un deployment curat, șterge resursa `OpsAlertsEmailSubscription` din template, deploy, apoi re-adaug-o și confirmă imediat.
- **Postman:** nu mai există un deployment live; setează `baseUrl` la URL-ul noului deployment după ce rulezi din nou infrastructura. Generează un IdToken cu `scripts/create-cognito-test-user.sh` (pentru un user existent, scriptul resetează parola) și setează `accessToken`; pentru bid folosește tokenul bidderului.
- **Benchmark:** rulat pe `benchmark-1`; rezultatele sunt în secțiunea 7 și în `benchmark-results/` local. Stage-ul și resursele `Retain` au fost șterse.
- **Commit:** nu s-a făcut commit; toate modificările sunt locale.

## 7. Benchmark Lambda

Rulat cu:

```bash
npm run benchmark:lambda -- \
  --stage benchmark-1 \
  --confirm-disposable-stage benchmark-1 \
  --warm-invocations 3
```

> Stage-ul `benchmark-auctions` a fost respins de S3 pentru că numele bucket-ului depășea 63 de caractere. Resursele reținute au fost șterse, iar rularea a folosit `benchmark-1`.

Rezultate din `summary.csv` (media include 1 invocare cold + 3 warm; costul este estimat cu prețurile ARM configurate în script):

| Funcție | Memorie | Durată medie (ms) | Cost / invocare (USD) | Decizie |
|---|---:|---:|---:|---|
| `api` | 128 | 945.50 | 0.0000017758 | cold ~3.7s |
| `api` | 256 | 948.00 | 0.0000033600 | cold ~3.2s |
| `api` | 512 | 714.50 | 0.0000049634 | **păstrat**: warm 3–4ms, cold 2.85s |
| `api` | 1024 | 415.75 | 0.0000057434 | cost mai mare |
| `closeExpiredAuctions` | 128 | 1044.50 | 0.0000019408 | warm 131–158ms |
| `closeExpiredAuctions` | 256 | 527.50 | 0.0000019583 | **păstrat**: cost ≈128, warm 44–60ms |
| `closeExpiredAuctions` | 512 | 444.00 | 0.0000031600 | warm 11–14ms, cost mai mare |
| `closeExpiredAuctions` | 1024 | 382.25 | 0.0000052967 | cost mai mare |
| `sendWinnerNotification` | 128 | 1181.25 | 0.0000021688 | cel mai ieftin, dar fără rezervă de memorie |
| `sendWinnerNotification` | 256 | 721.25 | 0.0000026042 | **păstrat**: vârf observat ~139MB, headroom |
| `sendWinnerNotification` | 512 | 541.00 | 0.0000038067 | cost mai mare |
| `sendWinnerNotification` | 1024 | 460.50 | 0.0000063400 | cost mai mare |

**Decizie finală:** `api=512`, `closeExpiredAuctions=256`, `sendWinnerNotification=256`. Diferențele de cost sunt de ordinul micro-centului per invocare; pentru aplicația de curs, headroom-ul de memorie și cold start-ul mai bun contează mai mult decât optimizarea la 128 MiB. Valorile au fost restaurate după benchmark, iar stage-ul `benchmark-1` a fost șters integral (inclusiv resursele `Retain`).

Scriptul a necesitat două corecții pentru Windows/WSL: `tr -d '\r'` la citirea memoriei și păstrarea spațiului după `python -` la transmiterea argumentelor. Ambele sunt documentate în `DEBUGGING-GUIDE.md`.
