# Ghid de învățare AWS — aplicația de licitații serverless

Acest ghid explică **ce este în fiecare fișier YAML**, **ce fac funcțiile built-in** ale Serverless Framework și CloudFormation, **cum comunică stack-urile între ele** și **cum se leagă infrastructura de codul TypeScript**. Este scris pentru cineva care învață AWS, nu pentru un operator care doar rulează comenzi.

> Starea la 2026-11-01: infrastructura a fost deployată, verificată end-to-end și apoi **ștearsă integral** pentru a păstra contul fără costuri. URL-ul CloudFront folosit la testare nu mai este activ. Acest ghid rămâne referința pentru arhitectura Serverless Framework; următorul pas este migrarea pe **AWS CDK**.

---

## 1. Modelul mental: trei stack-uri, trei responsabilități

Aplicația este împărțită în **trei stack-uri CloudFormation** separate, fiecare cu propriul ciclu de viață:

| Stack | Fișier | Regiune | Ce creează | Când îl redesployezi |
|---|---|---|---|---|
| **infra** | `infra.yml` | `eu-central-1` | DynamoDB, S3, SQS/DLQ, Cognito, SNS, buget, parametri SSM | Rar: schimbi date, autentificare, cozi sau alerte |
| **api** | `api.yml` | `eu-central-1` | 3 funcții Lambda, API Gateway HTTP API, EventBridge, alarme, roluri IAM | Des: schimbi codul aplicației sau configurația de compute |
| **edge** | `edge.yml` | `us-east-1` | CloudFront + Lambda@Edge pentru header, opțional WAF/ACM/Route 53 | Rar: schimbi CDN-ul, domeniul sau protecția edge |

De ce separăm?

- **Blast radius:** un deploy de cod nu trebuie să atingă tabelele DynamoDB sau user pool-ul Cognito.
- **Regiuni diferite:** CloudFront, certificatele ACM și WAF pentru CloudFront trebuie create în `us-east-1`. Restul aplicației stă în `eu-central-1`.
- **Cost și viață:** resursele stateful au `DeletionPolicy: Retain`; un `sls remove` pe API nu trebuie să șteargă datele.

Ordinea corectă de deploy este:

```
infra.yml  ──scrie──►  SSM Parameters  ──citește──►  api.yml  ──scrie──►  SSM /api/id
   │                                                                          │
   └──────────────────────────┐                                               │
                              ▼                                               ▼
                         Cognito JWT  ─────────────────────────────────►  sync-edge-contract.sh
                                                                            │ (copiază id-ul
                                                                            │  în us-east-1)
                                                                            ▼
                                                                        edge.yml
                                                                            │
                                                                            ▼
                                                                      CloudFront URL
```

---

## 2. Harta fișierelor

```
infra.yml                  stack-ul stateful (DynamoDB, S3, SQS, Cognito, SNS, buget, SSM)
api.yml                    stack-ul de compute (Lambda, API Gateway, EventBridge, alarme)
edge.yml                   stack-ul edge (CloudFront, opțional WAF/ACM/Route 53)

resources/
  AuctionTableResource.yml              tabelul principal + indexuri + TTL
  NotificationIdempotencyTableResource.yml  claim/tombstone pentru emailuri
  AuctionImagesBucketResource.yml       bucket privat + versionare + lifecycle
  WinnerNotificationsQueueResource.yml  coada de notificări + 2 DLQ-uri
  CognitoAuthResource.yml               user pool, domeniu, client, MFA/parole/tokenuri
  SecurityResource.yml                  cheia KMS opțională pentru Lambda
  ObservabilityResource.yml             SNS topic, buget, cost anomaly detection
  AlarmsResource.yml                    8 alarme CloudWatch
  EdgeResource.yml                      distribuția CloudFront + opțional WAF/ACM/DNS

iam/
  ApiRole.yml                rolul funcției HTTP
  ExpirationRole.yml         rolul funcției care închide licitațiile
  WinnerNotificationRole.yml rolul consumatorului SQS care trimite email

plugins/
  common-layer.js            construiește layer-ul Linux ARM64 înainte de packaging
plugins.js                   plugin-uri esbuild (tsc + shim import.meta.url)

src/
  lambda.ts                  handler-ul HTTP (serverless-express + NestJS)
  auction-expiration.ts      handler-ul EventBridge care închide licitațiile
  winner-notification.ts     handler-ul SQS care trimite emailul
  app.module.ts              modulele NestJS pentru API
  config/runtime-config.ts   validarea env + citirea secreților din SSM
  http/create-http-application.ts  bootstrap Express/Nest, securitate, CORS
  modules/                   logica de business (auctions, images, expiration, notifications, health)
  common/                    guard-uri, filtre, logging, decoratori
  infrastructure/            clienți AWS reutilizați + lifecycle

scripts/
  configure-secrets.sh       scrie SecureString-urile în SSM (fără să le afișeze)
  sync-edge-contract.sh      copiază /api/id din eu-central-1 în us-east-1
  create-cognito-test-user.sh creează/confirmă un user de test și emite IdToken
  verify-deployment-artifacts.sh verifică ZIP-urile local, fără AWS
  benchmark-lambda-memory.sh măsoară memoriile într-un stage disposable
  validate-infrastructure.sh verificări locale de configurație

postman/Auctions.postman_collection.json  fluxul end-to-end manual
```

---

## 3. Contractul dintre stack-uri: SSM Parameters

Stack-ul `infra` nu exportă direct resurse către `api`; scrie **parametri SSM** cu nume și ARN-uri. `api.yml` îi citește la deploy cu `${ssm:...}`. Acesta este contractul cross-stack.

| Parametru SSM (`/nestjs-aws-serverless/prod/...`) | Scris de | Citit de | Rol |
|---|---|---|---|
| `auctions/table-name` | infra | api (env Lambda) | numele tabelului |
| `auctions/table-arn` | infra | IAM | ARN-ul pentru least privilege |
| `images/bucket-name` | infra | api (env Lambda) | bucket-ul de imagini |
| `winner-notifications/queue-url` | infra | api (env Lambda) | URL-ul cozii |
| `winner-notifications/queue-arn` | infra | api (event source mapping) | ARN-ul cozii |
| `winner-notifications/dlq-url` / `dlq-arn` | infra | api/IAM | DLQ pentru consumator |
| `auction-expiration/dlq-url` / `dlq-arn` | infra | api (EventBridge + IAM) | DLQ pentru schedule |
| `cognito/issuer-url` | infra | api (authorizer) | issuer-ul JWT |
| `cognito/client-id` | infra | api (authorizer audience) | audience-ul JWT |
| `notifications/idempotency-table-name` | infra | api (env Lambda) | tabela de idempotență |
| `alerts/topic-arn` | infra | alarme | topic-ul SNS |
| `api/id` | **api** (eu-central-1) | **edge** (us-east-1, după `sync-edge-contract.sh`) | ID-ul API Gateway pentru originea CloudFront |
| `secrets/edge-shared-secret` | `configure-secrets.sh` | api + Lambda@Edge | secretul care dovedește că requestul vine prin CloudFront |
| `secrets/ses-sender-email` | `configure-secrets.sh` | notification Lambda | expeditorul SES |

**De ce SSM și nu Outputs?** Outputs-urile unui stack sunt vizibile doar în acel stack/regiune și nu se pot citi simplu din alt stack Serverless. SSM este un registru regional, versionat, cu permisiuni IAM fine.

**Atenție la regiune:** SSM este regional. `api.yml` scrie `/api/id` în `eu-central-1`, dar `edge.yml` rulează în `us-east-1` și citește același nume de acolo. De aceea există `scripts/sync-edge-contract.sh`: copiază doar acest identificator ne-secret între regiuni. Fără el, packaging-ul edge eșuează cu „Cannot resolve ${ssm:.../api/id}”.

**Atenție:** `${ssm:...}` este rezolvat de Serverless **la deploy**, nu la runtime. Pentru SecureString-uri, valoarea nu trebuie să ajungă în template; de aceea codul le citește la cold start cu `ssm:GetParameter --with-decryption`.

---

## 4. Serverless Framework: variabilele folosite în proiect

Serverless înlocuiește `${...}` înainte de a trimite template-ul la CloudFormation.

| Sintaxă | Exemplu din proiect | Ce face |
|---|---|---|
| `${self:...}` | `${self:custom.project}` | citește o valoare din același fișier |
| `${opt:stage}` | `${opt:stage, 'dev'}` | valoarea `--stage` din CLI, cu fallback |
| `${sls:stage}` | `${sls:stage}` | stage-ul rezolvat de framework |
| `${env:NAME, 'default'}` | `${env:CORS_ORIGIN, 'https://...'}` | variabilă de mediu la deploy, cu fallback |
| `${param:name}` | `${param:pitrEnabled}` | parametru definit în blocul `params` pentru stage |
| `${file(./resources/X.yml):Key}` | `${file(./resources/AuctionTableResource.yml):AuctionsTable}` | include un fragment YAML |
| `${ssm:/path}` | `${ssm:/nestjs-aws-serverless/${sls:stage}/cognito/client-id}` | citește un SSM Parameter la deploy |
| `${aws:accountId}` | `${aws:accountId}` | ID-ul contului AWS |
| `${strToBool(...)}` | `${strToBool(${env:DYNAMODB_PITR_ENABLED, 'false'})}` | transformă string-ul `"true"`/`"false"` în boolean |

### `params` și `custom`

```yaml
params:
  default:
    pitrEnabled: false
  prod:
    pitrEnabled: false   # cost-safe: PITR se activează explicit

custom:
  pitrEnabled: ${strToBool(${env:DYNAMODB_PITR_ENABLED, '${param:pitrEnabled}'})}
```

Ordinea de rezolvare: dacă `DYNAMODB_PITR_ENABLED` este setat, câștigă; altfel se folosește valoarea pentru stage. `strToBool` este un resolver built-in în Serverless Framework 4 (nu o funcție definită în proiect).

### `external` și `exclude` la esbuild

- `external` = pachete care **nu** se pun în ZIP-ul funcției; sunt încărcate din layer la `/opt/nodejs/node_modules`.
- `exclude: ['*']` = nu copia `node_modules` în ZIP; totul vine din layer.
- `format: esm` + `outputFileExtension: '.mjs'` = bundle-ul este ES module, obligatoriu pentru NestJS 12, care este ESM-only. Fără ele, Node încearcă `require()` pe un modul ESM și apare `ERR_REQUIRE_ESM`.

---

## 5. CloudFormation: funcțiile built-in folosite

| Funcție | Exemplu | Ce face |
|---|---|---|
| `!Ref` | `!Ref AuctionsTable` | returnează valoarea resursei (numele fizic pentru multe resurse) |
| `!GetAtt` | `!GetAtt AuctionsTable.Arn` | returnează un atribut al resursei |
| `!Sub` | `!Sub 'arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:...'` | înlocuiește variabile în string |
| `!Join` | `!Join ['', ['https://cognito-idp.', !Ref 'AWS::Region', ...]]` | lipește o listă |
| `!If` | `!If [UseWaf, !GetAtt EdgeWebAcl.Arn, !Ref 'AWS::NoValue']` | alege o valoare sau omite proprietatea |
| `!Equals` / `!And` / `!Not` | condiții în `Conditions` | logică booleană la deploy |
| `Fn::GetAtt`, `Fn::Join`, `Fn::If` | formă lungă a aceleiași funcții | util când nu se poate folosi `!Funcție` |
| `AWS::NoValue` | `!Ref AWS::NoValue` | șterge proprietatea când condiția este falsă |
| `DeletionPolicy: Retain` | tabele, bucket, cozi, Cognito | resursa supraviețuiește `sls remove` |
| `UpdateReplacePolicy: Retain` | aceleași resurse | la înlocuire, datele vechi rămân |
| `{{resolve:ssm-secure:...}}` | nu se folosește în `CloudFront Origins` | CloudFormation nu acceptă SecureString acolo; Lambda@Edge citește secretul la runtime |

### Conditions și cost-safe toggles

```yaml
Conditions:
  UseLambdaCmk: !Equals ['${self:custom.lambdaCmkEnabled}', true]
  UseWaf: !Equals ['${self:custom.wafEnabled}', true]
```

Când condiția este falsă, resursa marcată `Condition: UseWaf` nu este creată deloc. Astfel profilul cost-safe nu creează WAF, KMS, ACM sau Route 53.

`!If [UseLambdaCmk, "...", !Ref AWS::NoValue]` este varianta pentru o **proprietate** opțională: fie o setează, fie o omite.

### DeletionPolicy și teardown

`DeletionPolicy: Retain` este utilă în producție (nu pierzi date la un deploy greșit), dar înseamnă că **`sls remove` nu șterge** tabelele, bucket-ul, cozile și user pool-ul. Pentru a opri costurile trebuie să le ștergi explicit. Vezi secțiunea 11.

---

## 6. Fluxul HTTP: de la Postman la DynamoDB

```
Postman / browser
      │  HTTPS
      ▼
CloudFront (edge.yml, us-east-1)
      │  Lambda@Edge origin-request citește SecureString-ul din SSM
      │  și adaugă header x-auctions-edge-key
      ▼
API Gateway HTTP API (api.yml)
      │  validează JWT prin Cognito authorizer
      ▼
Lambda api (src/lambda.ts)
      │  EdgeOriginGuard verifică header-ul
      │  NestJS + Express + ValidationPipe
      ├──► DynamoDB auctions table (create/get/list/update/bid)
      └──► S3 bucket (imagine WebP + thumbnail)
                    │
                    └──► URL semnat, valabil 300 secunde
```

### Pași concreți

1. **CloudFront** primește requestul pe `https://<distribution>.cloudfront.net/...`.
2. **Lambda@Edge** (`origin-request`) citește SecureString-ul din SSM în `us-east-1` și adaugă header-ul `x-auctions-edge-key`. Nu punem secretul direct în distribuție: CloudFormation respinge `ssm-secure` în `Origins`.
3. **API Gateway** aplică throttling (100 req/s, burst 200) și, pentru POST/PATCH, autorizatorul Cognito.
4. **Cognito** emite IdToken-ul; API Gateway verifică semnătura, issuer-ul și audience-ul.
5. **Lambda api** pornește NestJS. `EdgeOriginGuard` respinge cu 403 orice request direct la API care nu are header-ul corect.
6. **Ownership:** `createdBy` vine din claims-ul JWT, nu din body; un alt user primește 403 la update.
7. **DynamoDB**: create/update/bid folosesc condiții atomice; listarea folosește cursor pagination.
8. **S3**: imaginea este validată, convertită cu Sharp în WebP + thumbnail, urcată privat; citirea se face doar prin URL semnat.

### De ce CloudFront dacă API Gateway are deja HTTPS?

- un singur URL public, fără domeniu cumpărat;
- cache/compresie și protecție edge (opțional WAF);
- originea API poate fi ținută ascunsă: `EdgeOriginGuard` face API-ul inutilizabil direct;
- certificatul implicit CloudFront oferă HTTPS gratuit pe `*.cloudfront.net`.

---

## 7. Fluxul asincron: expirare → SQS → SES

```
EventBridge (rate 5 minutes)
      │
      ▼
Lambda closeExpiredAuctions (src/auction-expiration.ts)
      │  1. caută licitații ACTIVE cu endDate trecut
      │  2. update condiționat ACTIVE → CLOSED
      │  3. șterge imaginile din S3
      │  4. trimite mesaj SQS { auctionId, recipient, title, winningBid }
      ▼
SQS winner-notifications
      │  batch size 10, ReportBatchItemFailures
      ▼
Lambda sendWinnerNotification (src/winner-notification.ts)
      │  1. claim idempotent în DynamoDB (auctionId)
      │  2. trimite email prin SES
      │  3. marchează COMPLETED (tombstone 30 zile)
      ▼
SES → email către câștigător
```

### DLQ-uri și alarme

| DLQ | Cine trimite | Alarme |
|---|---|---|
| `winner-notifications-dlq` | SQS după 3 recepții eșuate | mesaje vizibile, vechime |
| `auction-expiration-dlq` | EventBridge după 2 retry-uri | mesaje vizibile, vechime |
| — | Lambda expiration/notification | Errors, Throttles |

Cele 8 alarme publică în SNS topic-ul `nestjs-aws-serverless-prod-ops-alerts`. Abonarea pe email trebuie **confirmată**; o subscripție pending expiră după 48 de ore.

### Idempotența

Cheia este `auctionId`. Consumerul face un `PutItem` condiționat:
- dacă nu există claim → procesează;
- dacă există claim activ → așteaptă/retry;
- dacă este `COMPLETED` → ignoră duplicatul.

Există o fereastră documentată: SES poate trimite emailul, apoi procesul poate muri înainte de marcarea `COMPLETED`; un retry poate trimite din nou. Este un compromis explicit, nu o promisiune de exactly-once.

---

## 8. Harta codului

| Fișier / modul | Rol |
|---|---|
| `src/lambda.ts` | bootstrap NestJS + serverless-express; handler HTTP |
| `src/auction-expiration.ts` | handler EventBridge; închide licitațiile |
| `src/winner-notification.ts` | handler SQS; procesează fiecare record |
| `src/config/runtime-config.ts` | Zod: validează env, citește SecureString-uri la cold start |
| `src/config/configuration.module.ts` | `ConfigModule.forRoot` global |
| `src/http/create-http-application.ts` | Express, helmet, CORS, validation, Swagger opțional |
| `src/common/guards/edge-origin.guard.ts` | verifică `x-auctions-edge-key` cu comparație constant-time |
| `src/common/decorators/current-user.decorator.ts` | extrage userul din claims-ul API Gateway |
| `src/modules/auctions/` | CRUD, paginare, bid, ownership |
| `src/modules/auctions/images/` | Sharp, WebP, thumbnail, S3, URL semnat |
| `src/modules/auctions/expiration/` | query index, close atomic, S3 cleanup, SQS enqueue |
| `src/modules/notifications/` | claim idempotent, SES resilience, handler SQS |
| `src/modules/health/` | verifică DynamoDB + SQS, timeout, 503 sanitizat |
| `src/infrastructure/` | clienți AWS reutilizați, destroy idempotent |
| `src/common/logging/` | JSON logs, correlation ID, metrici EMF |

### Configurația la runtime

`loadRuntimeConfig()` este apelat înainte de bootstrap-ul Nest:
1. citește `SES_SENDER_EMAIL_PARAMETER` și `EDGE_SHARED_SECRET_PARAMETER` din SSM cu decriptare;
2. validează tot env-ul cu Zod;
3. pune valorile în `process.env`, de unde le citesc serviciile.

De aceea funcția `api` are doar `EDGE_SHARED_SECRET_PARAMETER`, iar `sendWinnerNotification` are doar `SES_SENDER_EMAIL_PARAMETER`: fiecare rol poate citi doar secretul de care are nevoie.

---

## 9. IAM: cine poate face ce

| Rol | Funcție | Acțiuni principale | Resurse |
|---|---|---|---|
| `AuctionsApiRole` | `api` | DynamoDB CRUD/Query/Scan, S3 Get/Put/Delete, SQS GetQueueAttributes, SSM GetParameter | tabel, bucket, coadă, secretul edge |
| `AuctionsExpirationRole` | `closeExpiredAuctions` | DynamoDB Query/Update, S3 Delete, SQS SendMessage | indexuri, bucket, coadă |
| `WinnerNotificationRole` | `sendWinnerNotification` | SQS Receive/Delete/ChangeVisibility, SES SendEmail, DynamoDB claim, SSM GetParameter | coadă, tabelă idempotență, sender SES |

De ce `Resource: '*'` la SES? API-ul `ses:SendEmail` nu suportă resource-level permissions pentru identități în toate cazurile; restricția se face prin identitatea verificată și prin politica contului. Este documentat în `iam/WinnerNotificationRole.yml`.

De ce `kms:Decrypt`? Lambda are nevoie de el pentru variabilele de mediu criptate și pentru SSM SecureString. Când nu există CMK, cheia AWS-owned nu cere permisiune explicită, dar politica rămâne pregătită pentru profilul full production.

---

## 10. Costuri: ce este gratuit și ce poate costa

| Serviciu | Setare cost-safe | Cost așteptat |
|---|---|---|
| CloudFront | `PriceClass_100`, certificat implicit, fără WAF | $0 în free tier (1 TB + 10M requests) |
| Lambda@Edge | citește secretul din SSM; rulare per request | foarte mic la volumul de curs; nu are free tier separat |
| API Gateway HTTP | 100 req/s, burst 200 | free tier / ~$1 per milion |
| Lambda | ARM64, 512/256/256 MiB | free tier (1M requests + 400k GB-s) |
| DynamoDB | on-demand, TTL, PITR off | bănuți pentru date de test |
| S3 | privat, versionare + expirare 7 zile | bănuți sub 5 GB |
| SQS | 3 cozi, retenție 14 zile | free tier |
| SNS | email | free/low |
| Cognito | user pool mic, MFA opțional | free tier |
| SES | sandbox, doar destinatari verificați | $0.10 / 1.000 emailuri |
| CloudWatch | 8 alarme, logs 7 zile | 10 alarme free, 5 GB logs free |
| Budgets | 1 buget $5 | primele 2 bugete free |

**Nu se creează:** WAF, KMS customer-managed, ACM, Route 53 Hosted Zone, PITR, DAX, ElastiCache, provisioned concurrency, NAT Gateway, EC2, RDS.

Reguli:
- Alerta de buget **nu oprește** cheltuielile; verifică pagina Billing/credits.
- Benchmark-ul rulează doar într-un stage `benchmark-*` și se șterge imediat.
- Resursele `Retain` trebuie șterse manual la teardown.
- Nu rula `aws ce get-cost-and-usage` pentru curiozitate: API-ul Cost Explorer costă $0.01 per request.

---

## 11. Teardown: cum oprești toate costurile

> Atenție: pașii 3–4 șterg date. Fă-i doar când ai terminat învățarea sau vrei să resetezi complet.

```bash
# 1. Edge (CloudFront)
npx sls remove --config edge.yml --stage prod

# 2. API (Lambda, API Gateway, alarme, EventBridge)
npx sls remove --config api.yml --stage prod

# 3. Infra (SNS, buget, parametri SSM)
npx sls remove --config infra.yml --stage prod

# 4. Resurse Retain rămase — șterge-le explicit
aws dynamodb delete-table --table-name nestjs-aws-serverless-auctions-prod --region eu-central-1
aws dynamodb delete-table --table-name nestjs-aws-serverless-notification-idempotency-prod --region eu-central-1
# S3: golește toate versiunile înainte de delete-bucket
aws s3api delete-objects --bucket <bucket> --delete "$(aws s3api list-object-versions ...)"
aws s3api delete-bucket --bucket <bucket> --region eu-central-1
aws cognito-idp delete-user-pool --user-pool-id <pool-id> --region eu-central-1
aws sqs delete-queue --queue-url <url> --region eu-central-1   # 3 cozi
aws ssm delete-parameters --names /nestjs-aws-serverless/prod/secrets/edge-shared-secret /nestjs-aws-serverless/prod/secrets/ses-sender-email --region eu-central-1
```

Verifică apoi:
```bash
aws cloudformation list-stacks --region eu-central-1
aws dynamodb list-tables --region eu-central-1
aws sqs list-queues --region eu-central-1
aws s3api list-buckets
aws cognito-idp list-user-pools --max-results 10 --region eu-central-1
```
Nu șterge bucket-ul de deployment al Serverless (`serverless-framework-deployments-...`) până nu ai scos toate stack-urile.

---

## 12. Troubleshooting

| Simptom | Cauză probabilă | Fix |
|---|---|---|
| `ERR_REQUIRE_ESM` la cold start | bundle CJS cu NestJS 12 ESM | `format: esm`, `outputFileExtension: '.mjs'`, `forceEsm: true` |
| `Cannot find package '@nestjs/core'` | ESM nu găsește layer-ul | bundlează `@nestjs/*` (scoate din `external`) sau verifică structura `nodejs/node_modules` |
| `/health` direct → 500 | funcția nu pornește | verifică CloudWatch Logs la init, nu doar răspunsul |
| `/health` direct → 403 | `EdgeOriginGuard` funcționează | normal; folosește CloudFront sau header-ul corect |
| CloudFront → 502/504 | originea API nu răspunde | verifică API Gateway și logs |
| CloudFront → 403 | header-ul edge lipsește/greșit | verifică logurile Lambda@Edge și valoarea din SSM |
| CloudFront → 502/503 | Lambda@Edge nu poate citi SSM sau a expirat | verifică rolul `EdgeOriginHeaderRole`, regiunea `us-east-1` și logurile funcției |
| `Unsupported property [OriginProtocolPolicy]` | proprietatea este pusă direct pe Origin | mută-o sub `CustomOriginConfig` |
| SNS `PendingConfirmation` dispare | nu ai confirmat în 48h | recreează subscripția și confirmă imediat |
| SES refuză destinatarul | sandbox | verifică identitatea sau folosește `success@simulator.amazonses.com` |
| `ValidationException` la `UpdateItem` | un `#placeholder` din expresie nu este declarat în `ExpressionAttributeNames` | adaugă toate numele folosite în `UpdateExpression` și `ConditionExpression` |
| `sls remove` lasă tabele/bucket | `DeletionPolicy: Retain` | șterge-le manual (secțiunea 11) |

---

## 13. Exerciții de învățare

1. Deschide `infra.yml` și urmărește un parametru SSM de la `Name` până la consumatorul lui din `api.yml`.
2. Schimbă `logRetentionInDays` în `api.yml` și observă diferența în CloudWatch Logs.
3. Activează `DYNAMODB_PITR_ENABLED=true` într-un stage de test și verifică `describe-continuous-backups`.
4. Adaugă o alarmă nouă în `resources/AlarmsResource.yml` și verifică-i starea.
5. Activează `WAF_ENABLED=true` doar într-un cont de test și compară costul/efectul; apoi șterge stack-ul edge.
6. Rulează benchmark-ul și explică de ce memorie mai mare poate fi mai ieftină (durată mai mică).
7. Citește `src/modules/auctions/expiration/auction-expiration.service.ts` și găsește condiția atomică care evită închiderea dublă.

---

## 14. Glosar

- **Stack** — unitate CloudFormation care grupează resurse și le creează/actualizează/șterge împreună.
- **Stage** — sufix de mediu (`dev`, `prod`, `benchmark-*`); separă nume de resurse și date.
- **Layer** — arhivă comună montată la `/opt` în Lambda; aici ține dependențele Node și Sharp.
- **Cold start** — prima invocare după crearea unui execution environment; include init-ul NestJS.
- **DLQ** — coadă unde ajung mesajele eșuate după retry-uri.
- **Idempotency** — aceeași operație aplicată de mai multe ori produce un singur efect.
- **Presigned URL** — URL temporar semnat criptografic pentru un obiect privat din S3.
- **JWT authorizer** — API Gateway validează tokenul Cognito înainte de a invoca Lambda.
- **Retain** — resursa rămâne în cont după ștergerea stack-ului.
