# Serverless Auctions — NestJS 12 pe AWS

Aplicație de licitații cu API HTTP, imagini private optimizate și notificări prin email. Proiectul folosește NestJS 12, TypeScript 6, Node.js 24, Serverless Framework 4 și AWS SDK v3.

> Starea acestui branch (2026-11-01): **snapshot al implementării Serverless Framework**, verificat live în AWS și apoi șters integral pentru a păstra contul fără costuri. URL-ul CloudFront folosit la testare nu mai este activ. Următorul pas este migrarea aplicației pe **AWS CDK**. Fluxul create → bid → close → email, idempotența și benchmark-ul au fost verificate înainte de teardown; dovezile sunt în `docs/deployment-report.md`. Ghidul de învățare este `docs/aws-learning-guide.md`.

## 1. Harta sistemului

```text
Browser/Postman
      │ HTTPS; JWT la POST/PATCH
      ▼
CloudFront (WAF/ACM opțional)
      │ Lambda@Edge citește SecureString din SSM și adaugă x-auctions-edge-key
      ▼
API Gateway HTTP API ── Cognito JWT authorizer
      ▼
Lambda api (NestJS) ── EdgeOriginGuard verifică header-ul de origine
      ├── DynamoDB: licitații, licitări atomice, paginare
      ├── S3 privat: WebP + thumbnail, URL semnat 5 minute
      └── SQS: health/readiness

EventBridge, la fiecare 5 minute
      ▼
Lambda closeExpiredAuctions
      ├── ACTIVE → CLOSED, condiționat în DynamoDB
      ├── șterge cele două imagini din S3
      └── publică notificarea în SQS; PENDING permite retry

SQS WinnerNotificationsQueue
      ▼
Lambda sendWinnerNotification
      ├── claim idempotent în DynamoDB
      ├── SES: timeout + retry + jitter + circuit breaker
      └── eșecuri în DLQ; alarme CloudWatch → SNS → email
```

Infrastructura este separată în trei stack-uri:

| Fișier | Conținut | Regiune |
|---|---|---|
| `infra.yml` | DynamoDB, S3, SQS/DLQ, Cognito, KMS opțional, SNS, buget | `eu-central-1` |
| `api.yml` | Lambda, API Gateway, IAM, EventBridge, alarme | `eu-central-1` |
| `edge.yml` | CloudFront + Lambda@Edge pentru header; WAF/ACM/DNS opțional | `us-east-1` |

SSM Parameter Store este contractul dintre stack-uri. Nu folosi `Ref` pentru o resursă aflată în alt stack.

## 2. Cerințe și pornire locală

- Node.js `24.15+` din linia 24 și npm 10+;
- Git Bash pe Windows pentru scripturile `.sh`;
- AWS CLI numai pentru deploy sau teste contra resurselor reale;
- credențiale AWS prin lanțul standard SDK/CLI, niciodată în `.env`.

```bash
# Instalează exact dependențele din package-lock.json.
nvm install 24.15.0
nvm use 24.15.0
npm ci

# Pornește HTTP local; citește .env doar pentru dezvoltare.
cp .env.example .env
npm run start:dev
```

Pe Windows, `cp` se execută în Git Bash. Poți copia fișierul și din Explorer. Pentru acces la DynamoDB/S3 reale, completează numele resurselor unui stage de test. Nu pune chei AWS în `.env`.

API-ul local ascultă pe `http://localhost:3000`. Swagger este disponibil la `/docs` în afara producției sau când `API_DOCS_ENABLED=true`.

## 3. Verificări locale

Fiecare comandă are un rol separat:

```bash
# Teste unitare și contracte de infrastructură, serial pentru rezultate reproductibile.
npm test -- --runInBand

# Flux HTTP prin Nest: validare, ownership, erori și health.
npm run test:e2e -- --runInBand

# Verifică tipurile fără să genereze fișiere.
npm run typecheck

# Reguli statice pentru src și test.
npm run lint

# Generează dist/ prin Nest.
npm run build

# Verifică formatarea fără să rescrie fișierele.
npx prettier --check "src/**/*.ts" "test/**/*.ts"

# Sintaxa tuturor scripturilor operaționale; nu apelează AWS.
bash -n scripts/*.sh
```

`npm run verify:artifacts` verifică integritatea și limita de 5 MiB pentru cele trei ZIP-uri Lambda, dar numai după un packaging API reușit.

## 4. Contract HTTP

| Rută | Auth | Rezultat |
|---|---|---|
| `GET /health` | public | 200 numai dacă DynamoDB și SQS răspund; altfel 503 |
| `GET /auctions` | public | pagină `{ items, nextCursor? }`; filtre `status`, `limit`, `cursor` |
| `GET /auctions/active` | public | licitații ACTIVE ordonate după `endDate`, paginat |
| `GET /auctions/:id` | public | o licitație |
| `POST /auctions` | Cognito JWT | creează licitație + imagine |
| `PATCH /auctions/:id` | JWT + owner | actualizare atomică; alt owner primește 403 |
| `POST /auctions/:id/bids` | JWT | licitare atomică; creatorul nu poate licita la propria licitație |

Paginarea are `limit=50` implicit și maximum `100`. Cursorul este opac: trimite-l înapoi fără să îl modifici. Exemplu:

```http
GET /auctions?status=ACTIVE&limit=25&cursor=CURSOR_PRIMIT
```

Crearea folosește `multipart/form-data` cu `title`, `status=ACTIVE`, `endDate` ISO 8601 și fișierul `image`. JPEG, PNG și WebP sunt verificate prin MIME și magic bytes, maximum 5 MiB și 40 MP. Nu seta manual header-ul multipart `Content-Type`, deoarece clientul trebuie să genereze boundary-ul.

Aplicația produce:

- imagine WebP maximum 1600×1600, calitate 80, maximum 2 MiB;
- thumbnail WebP maximum 320×320, calitate 75, maximum 256 KiB;
- URL privat de citire valabil 300 secunde, cu `Content-Type: image/webp` și nume de fișier sigur.

Închiderea directă prin POST/PATCH este respinsă. Numai workflow-ul de expirare poate închide o licitație, ca să nu ocolească ștergerea imaginii și notificarea.

Erorile HTTP au forma `{ statusCode, message, path, requestId }`. Răspunsurile 500 nu expun mesaje ale providerilor. `x-request-id` și `x-correlation-id` leagă răspunsul de loguri.

## 5. Variabile de configurare

`.env.example` este numai pentru dezvoltare locală. În Lambda, `api.yml` injectează identificatori prin SSM; valorile secrete sunt citite la bootstrap ca `SecureString`.

| Variabilă | Rol |
|---|---|
| `NODE_ENV`, `APP_FUNCTION` | mediu și tip de entry point |
| `AWS_REGION` | regiunea SDK, implicit `eu-central-1` |
| `PORT` | port HTTP local, implicit 3000 |
| `AUCTIONS_TABLE` | tabelul licitațiilor |
| `AUCTION_IMAGES_BUCKET` | bucket-ul privat |
| `WINNER_NOTIFICATIONS_QUEUE_URL` | coada principală |
| `WINNER_NOTIFICATIONS_DLQ_URL` | fallback manual DLQ |
| `NOTIFICATION_IDEMPOTENCY_TABLE` | claim-uri și tombstone-uri |
| `SES_SENDER_EMAIL_PARAMETER` | numele SecureString pentru expeditor |
| `EDGE_SHARED_SECRET_PARAMETER` | numele SecureString pentru origin |
| `CORS_ORIGINS` | origini exacte, separate prin virgulă |
| `API_DOCS_ENABLED` | activează Swagger explicit |
| `HEALTH_CHECK_TIMEOUT_MS` | timeout per dependență, 1–5000 ms, implicit 1000 |
| `SES_TIMEOUT_MS` | timeout per încercare SES, implicit 5000 |
| `SES_RETRY_MAX_ATTEMPTS` | maximum 5; implicit 3 |
| `SES_RETRY_BASE_MS` | baza backoff-ului, implicit 100 ms |
| `SES_CIRCUIT_FAILURE_THRESHOLD` | erori tranzitorii consecutive; implicit 3 |
| `SES_CIRCUIT_COOLDOWN_MS` | cooldown circuit, implicit 30000 ms |

Pentru deploy mai sunt folosite `RESOURCE_OWNER`, `ALERT_EMAIL`, `BUDGET_LIMIT_USD`, `DYNAMODB_PITR_ENABLED`, `LAMBDA_CMK_ENABLED`, `LAMBDA_RESERVED_CONCURRENCY_ENABLED`, `WAF_ENABLED`, `COGNITO_CALLBACK_URL`, `COGNITO_LOGOUT_URL`, `PROD_CUSTOM_DOMAIN_ENABLED`, `PROD_API_DOMAIN`, `PROD_HOSTED_ZONE_ID` și `WAF_RATE_LIMIT`.

Profilul cost-safe folosește `DYNAMODB_PITR_ENABLED=false`, `LAMBDA_CMK_ENABLED=false`, `WAF_ENABLED=false` și `PROD_CUSTOM_DOMAIN_ENABLED=false`. PITR, cheia KMS proprie, WAF-ul, certificatul ACM și Route 53 sunt opt-in explicit; vezi tabelul de costuri din `docs/aws-learning-guide.md`.

## 6. Deploy real, în ordinea corectă

Comenzile următoare creează resurse și pot genera costuri. Rulează-le numai într-un cont/stage pe care ai voie să îl modifici. Exemplele `example.com` nu sunt domenii funcționale.

```bash
# Alege stage-ul și proprietarul resurselor; nu publica emailul în repository.
export STAGE=dev
export RESOURCE_OWNER=echipa-ta
export ALERT_EMAIL=ops@domeniul-tau.real
export CORS_ORIGINS=https://app.domeniul-tau.real
export COGNITO_CALLBACK_URL=https://app.domeniul-tau.real/callback
export COGNITO_LOGOUT_URL=https://app.domeniul-tau.real/

# 1. Creează resursele stateful și parametrii SSM ne-secreți.
npx sls deploy --config infra.yml --stage "$STAGE"

# 2. Scrie secretele direct în SSM; scriptul nu afișează valorile.
export SES_SENDER_EMAIL=sender-verificat@domeniul-tau.real
export EDGE_SHARED_SECRET='UN-SECRET-ALEATOR-LUNG-DE-MINIM-24-CARACTERE'
bash scripts/configure-secrets.sh
unset SES_SENDER_EMAIL EDGE_SHARED_SECRET

# 3. Creează funcțiile și API-ul după ce toți parametrii există.
npx sls deploy --config api.yml --stage "$STAGE"

# 4. Copiază /api/id în us-east-1; SSM este regional, iar edge.yml citește de acolo.
bash scripts/sync-edge-contract.sh "$STAGE"

# 5. Creează distribuția CloudFront + Lambda@Edge.
#    WAF/ACM/Route 53 rămân dezactivate în profilul cost-safe.
WAF_ENABLED=false PROD_CUSTOM_DOMAIN_ENABLED=false \
  npx sls deploy --config edge.yml --stage "$STAGE"
```

Confirmă abonarea SNS trimisă la `ALERT_EMAIL` **în maximum 48 de ore**; altfel AWS șterge subscripția pending și CloudFormation rămâne în drift. În SES sandbox, verifică și destinatarii de test sau folosește simulatorul SES. Pentru domeniu real, urmează secțiunea ACM/DNS din `docs/architecture.md` înainte de a activa aliasul.

Edge-ul folosește o funcție Lambda@Edge `origin-request` care citește SecureString-ul din SSM și adaugă `x-auctions-edge-key`. Motivul: CloudFormation nu permite `ssm-secure` direct în `CloudFront Distribution Origins`. Costul Lambda@Edge este per invocare, foarte mic la volumul de curs; alternativ, profilul full production poate folosi un CloudFront Function + KeyValueStore.

### Cost control

- Bugetul este 5 USD, cu alertă la 80% (4 USD); **alerta nu oprește** cheltuielile.
- WAF, KMS customer-managed, PITR, ACM și Route 53 sunt oprite implicit.
- Logs 7 zile, TTL pe DynamoDB și lifecycle S3 reduc stocarea.
- Nu există NAT Gateway, EC2, RDS sau provisioned concurrency.
- Pentru oprirea completă, urmează teardown-ul din `docs/aws-learning-guide.md`; `sls remove` nu șterge resursele `Retain`.

Nu rula benchmark-ul dacă creditul rămas este sub ~3 USD. Costul estimat este de ordinul cenților, dar nu este zero.

### Stare operațională în timpul verificării

> Resursele AWS au fost șterse după verificare; aceste rezultate sunt istorice, nu o stare live.

- CloudFront `https://d1sik11s5f836g.cloudfront.net/health` → 200 `ok/up/up` (la momentul testării; URL inactiv acum).
- API Gateway direct, fără `x-auctions-edge-key` → 403; `POST` fără JWT → 401.
- CORS preflight din `http://localhost:3000` → 204 cu originea exactă și credentials; altă origine nu primește allow.
- Flux creat → bid → close → WebP șters din S3 → email SES: verificat prin CloudFront.
- Duplicate SQS: `WinnerNotificationDuplicate` de două ori, fără al doilea email; idempotența rămâne `COMPLETED`.
- Ambele DLQ-uri: 0 mesaje; toate cele 8 alarme: `OK`.
- **Acțiune rămasă pentru tine:** confirmă emailul SNS trimis la adresa de alertă configurată (subscripția este `PendingConfirmation`; expiră în 48h).
- **Drift SNS:** subscripția veche a expirat, iar CloudFormation o mai are în stare; subscripția nouă este manuală. Nu rula un update `infra.yml` cu `ALERT_EMAIL` schimbat fără să repari resursa. Detalii în `docs/deployment-report.md`.

Nu migra vechiul stack `nestjs-aws-serverless-dev` prin ștergere. Stack-urile noi pot intra în conflict cu numele resurselor existente; folosește un stage nou și o migrare de date planificată sau un import CloudFormation revizuit separat.

## 7. Postman și token de test

Importă `postman/Auctions.postman_collection.json`, apoi setează `baseUrl` la URL-ul noului API/CloudFront. Nu presupune că URL-ul din vechiul deploy mai este valid.

Scriptul următor creează/confirmă un utilizator de test și afișează un IdToken valabil o oră. Folosește o parolă unică, nu una reală; comanda apelează AWS.

```bash
# Preferă variabila de mediu ca parola să nu ajungă în istoricul shell-ului.
STACK_NAME=nestjs-aws-serverless-infra-prod \
  TEST_USER_PASSWORD='PAROLA-UNICA-DE-TEST' \
  bash scripts/create-cognito-test-user.sh creator-test@example.com
```

Dacă userul există deja, scriptul îi resetează parola cu `admin-set-user-password` și emite un IdToken nou. Pune tokenul în variabila Postman `accessToken`. Pentru licitare, folosește tokenul altui utilizator. Rulează cererea de închidere numai după `endDate` plus următorul interval EventBridge.

## 8. Benchmark și operare

Benchmark-ul modifică temporar memoria funcțiilor și invocă handler-e reale. Este refuzat pentru `prod` și pentru orice stage care nu începe cu `benchmark-`.

```bash
# Necesită un stage izolat, deja deploy-at, numai cu date de test; poate genera costuri.
npm run benchmark:lambda -- \
  --stage benchmark-1 \
  --confirm-disposable-stage benchmark-1 \
  --warm-invocations 3
```

Scriptul testează 128/256/512/1024 MiB, colectează `Billed Duration`, estimează costul ARM și restaurează memoria inițială la ieșire. Notificările folosesc `success@simulator.amazonses.com`; expirarea poate închide datele din stage-ul izolat. Alege configurația după cost per invocare și durată, nu doar după viteză.

Stage-ul trebuie să fie scurt: numele bucket-ului S3 include `${project}-auction-images-${stage}-${accountId}` și trebuie să rămână sub 63 de caractere. `benchmark-auctions` depășește limita; folosește `benchmark-1`.

Rezultate măsurate (detalii în `docs/deployment-report.md`): cea mai ieftină valoare per invocare este 128 MiB pentru toate funcțiile, dar diferențele sunt micro-centuri, iar cold start-ul și rezerva de memorie contează. Configurația finală rămâne **api 512 / expiration 256 / notification 256**: API-ul are warm 3–4 ms și cold ~2,85 s la 512; notification a avut un vârf de ~139 MB, deci 128 MiB ar fi riscant.

Ghiduri:

- `docs/aws-learning-guide.md` — **începe aici**: harta stack-urilor, variabilele Serverless, funcțiile CloudFormation, fluxurile HTTP/asincrone, costuri și teardown;
- `docs/deployment-report.md` — dovezile live, defectele găsite/reparate și rezultatele benchmark-ului;
- `docs/architecture.md` — resurse, securitate, deploy, rollback și operare;
- `SQS-FLOW-EXPLAINED.md` — idempotență, retry, DLQ și circuit breaker;
- `DEBUGGING-GUIDE.md` — investigare cu dovezi în CloudWatch;
- `AWS-YML-CHEATSHEET.md` — curs AWS pentru student, legat de acest proiect.
