# AWS YAML Cheat Sheet — producție + AWS Developer Associate

> Repere rapide pentru serviciile și fișierele acestui proiect. YAML descrie starea dorită; comenzile AWS CLI inspectează sau administrează starea reală.

## 1. Harta fluxului actual

```text
Postman/browser
  │ HTTPS + JWT la mutații
  ▼
API Gateway HTTP API ── autorizare Cognito ──► Lambda API (NestJS)
  │                                             ├─ DynamoDB: licitații + bid atomic
  │                                             ├─ S3 privat: imagine obligatorie
  │                                             └─ GET: URL S3 semnat, 5 minute
  │
EventBridge Scheduler (la 5 minute)
  ▼
Lambda expiration ──► DynamoDB: ACTIVE → CLOSED + remove imageKey
  │                       └─ apoi S3 DeleteObject (best effort)
  ▼
SQS winner queue ──► Lambda notification ──► SES ──► email câștigător
  │ eșec după retry
  ▼
SQS DLQ + CloudWatch alarms/logs
```

**Lanțul de configurare:** `serverless.yml` compune resursele din `resources/*.yml` și permisiunile din `iam/*.yml`; Serverless Framework generează CloudFormation; CloudFormation creează/actualizează stack-ul.

## 2. YAML, Serverless Framework și CloudFormation

**Rol:** infrastructură declarativă, repetabilă și versionată. **Stack** = resursele administrate împreună; **template** = descrierea lor; **change set** = previzualizarea modificărilor.

| Concept | Ce reții |
|---|---|
| `${self:service}`, `${sls:stage}` | variabile evaluate de Serverless |
| `${env:NAME, 'fallback'}` | configurare din mediu; nu pune secrete în YAML |
| `${file(resources/X.yml)}` | include resurse separate |
| `Ref: LogicalId` | ID-ul fizic sau valoarea principală a resursei |
| `Fn::GetAtt: [LogicalId, Arn]` | atribut al resursei, frecvent ARN |
| `Fn::Sub` | interpolare în template-ul CloudFormation |
| `DependsOn` | dependență explicită; referințele creează de obicei dependențe implicite |
| `DeletionPolicy: Retain` | păstrează resursa la ștergerea stack-ului |
| `UpdateReplacePolicy` | comportament când resursa trebuie înlocuită |

**Producție:** stage/account separate, tag-uri `project/stage/owner`, PITR pentru DynamoDB, bucket/queue/User Pool cu retenție deliberată, review al change set-ului. Resursele stateful pot fi înlocuite la schimbarea anumitor proprietăți; nu presupune update „in-place”.

```bash
npm exec serverless -- print --stage dev
npm exec serverless -- package --stage dev
npm exec serverless -- deploy --stage dev
aws cloudformation describe-stacks --stack-name nestjs-aws-serverless-dev
aws cloudformation describe-stack-events --stack-name nestjs-aws-serverless-dev
aws cloudformation list-stack-resources --stack-name nestjs-aws-serverless-dev
```

**Examene/capcane:** `Ref` și `GetAtt` nu sunt interschimbabile; YAML nu rulează cod, ci declară resurse; rollback nu șterge automat datele din resurse reținute; coada și rolurile au ARN, bucket-ul are nume, iar `Ref` depinde de tipul resursei.

## 3. Lambda

**Rol:** rulează cod fără administrarea serverelor. Componente: handler, runtime, deployment package, memory/timeout, environment, execution role, event source și concurrency.

```yaml
handler: dist/lambda.handler
runtime: nodejs24.x
architecture: arm64
memorySize: 512
timeout: 30
environment:
  AUCTIONS_TABLE: !Ref AuctionTable
reservedConcurrency: 1 # expirare serializată
```

- **Sincron** (API Gateway): clientul primește eroarea; retry aparține clientului.
- **Asincron** (SQS/EventBridge): AWS poate retrimite; consumatorul trebuie idempotent.
- Cold start = inițializare mediu + cod; obiectele din afara handler-ului sunt reutilizate la warm start.
- Memory crește și CPU-ul; timeout nu rezolvă un apel extern fără timeout propriu.

```bash
aws lambda invoke --function-name FUNCTION out.json
aws lambda get-function-configuration --function-name FUNCTION
aws lambda update-function-configuration --function-name FUNCTION --timeout 30
```

**Examene/capcane:** Lambda primește permisiuni prin execution role; reserved concurrency limitează funcția, nu o scalează; pentru SQS poller-ul AWS invocă funcția; timeout-ul funcției trebuie mai mic decât visibility timeout-ul cozii.

## 4. API Gateway HTTP API

**Rol:** HTTPS → rute → integrare Lambda; aici validează Cognito JWT înainte de invocare.

```yaml
httpApi:
  cors:
    allowedOrigins: ${env:CORS_ORIGINS}
  authorizers:
    cognitoAuthorizer:
      type: jwt
      identitySource: $request.header.Authorization
      issuerUrl: https://cognito-idp.REGION.amazonaws.com/POOL_ID
      audience: [CLIENT_ID]
```

Rută: `ANY /auctions`, `GET /auctions/{id}`; payload 2.0 transmite `requestContext.authorizer.jwt.claims`. API Gateway gestionează preflight `OPTIONS`.

**Producție:** JWT pe toate mutațiile, CORS explicit, throttling la API/stage, loguri fără token/body, payload și timeout limitate. Nu trata autentificarea drept ownership: serviciul verifică resursa.

```bash
aws apigatewayv2 get-apis
aws apigatewayv2 get-routes --api-id API_ID
aws apigatewayv2 get-authorizers --api-id API_ID
```

**Examene/capcane:** HTTP API este de regulă mai simplu/ieftin decât REST API; JWT authorizer respinge token invalid, dar nu constrânge permisiunile IAM ale Lambda; `Authorization: Bearer TOKEN`; multipart boundary este generat de client.

## 5. Cognito User Pool + JWT

**Rol:** User Pool = director de utilizatori și emitent de tokenuri. App client = configurația aplicației; Hosted UI = login găzduit; grupuri = roluri opționale.

- **ID token:** identitatea utilizatorului pentru aplicație; aici conține `sub` și `email`.
- **Access token:** autorizare/API scopes; nu îl confunda cu ID token.
- **Refresh token:** obține tokenuri noi, nu se trimite ca Bearer la API.
- API verifică semnătura, `iss`, `aud`, `exp`; aplicația folosește `sub`, nu email/ID din body.

```bash
aws cognito-idp list-user-pools --max-results 20
aws cognito-idp admin-get-user --user-pool-id POOL_ID --username EMAIL
aws cognito-idp initiate-auth --user-pool-id POOL_ID --client-id CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH --auth-parameters USERNAME=EMAIL,PASSWORD=PASSWORD
```

**Producție/capcane:** nu crea parole/tokenuri în loguri; `DeletionPolicy: Retain`; token expirat = 401; creatorul nu poate licita pe propria licitație chiar dacă are JWT valid.

## 6. DynamoDB + GSI

**Rol:** NoSQL cheie-valoare/document cu acces predictibil prin chei. Table, item, attribute, partition key (`PK`), sort key (`SK`), GSI și LSI sunt conceptele de bază.

```yaml
BillingMode: PAY_PER_REQUEST
AttributeDefinitions:
  - { AttributeName: id, AttributeType: S }
KeySchema:
  - { AttributeName: id, KeyType: HASH }
GlobalSecondaryIndexes:
  - IndexName: status-endDate-index
    KeySchema:
      - { AttributeName: status, KeyType: HASH }
      - { AttributeName: endDate, KeyType: RANGE }
    Projection: { ProjectionType: ALL }
```

| Operație | Utilizare/capcană |
|---|---|
| `GetItem` | cheie primară completă, strongly consistent opțional |
| `Query` | o partition key + condiții pe sort key; eficient |
| `Scan` | citește tabelul/indexul; filtrează după citire; cost mare |
| `PutItem` | create/replace; condiție previne suprascrierea |
| `UpdateItem` | modificare atomică + `ConditionExpression` pentru bid/close |
| GSI | cheie alternativă, eventual consistent, throughput separat la provisioned |
| LSI | aceeași PK, alt SK; numai la crearea tabelei |
| `PAY_PER_REQUEST` | on-demand, fără capacity planning; nu face Scan gratis |
| PITR | restore la un moment din ultimele 35 zile; nu înlocuiește backup plan |

**Producție:** proiectează acces pattern-urile înaintea cheilor; paginare cu `Limit`/`ExclusiveStartKey`; projection doar cu atribute necesare; condiții pentru concurență; o singură creare/ștergere GSI per update CloudFormation.

```bash
aws dynamodb get-item --table-name TABLE --key '{"id":{"S":"UUID"}}'
aws dynamodb query --table-name TABLE --index-name status-endDate-index \
  --key-condition-expression '#s = :s' --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":s":{"S":"ACTIVE"}}'
aws dynamodb describe-table --table-name TABLE
```

## 7. S3 + Presigned URL

**Rol:** object storage. Bucket are nume global unic; object = key + bytes + metadata. Un prefix `auctions/` nu este un folder real.

```yaml
PublicAccessBlockConfiguration:
  BlockPublicAcls: true
  BlockPublicPolicy: true
  IgnorePublicAcls: true
  RestrictPublicBuckets: true
OwnershipControls:
  Rules: [{ ObjectOwnership: BucketOwnerEnforced }]
BucketEncryption:
  ServerSideEncryptionConfiguration:
    - ServerSideEncryptionByDefault: { SSEAlgorithm: AES256 }
LifecycleConfiguration:
  Rules:
    - Id: AbortIncompleteMultipartUploads
      Status: Enabled
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
```

- `PutObject` la create; `GetObject` prin URL semnat; `DeleteObject` la închidere.
- URL semnat împrumută temporar permisiunea semnatarului; bucket-ul rămâne privat; expirarea URL nu șterge obiectul.
- Deterministic key `auctions/{id}/image`; nu expune cheia internă în API.
- URL-ul semnat nu păstrează obiectul: după `DeleteObject`, cererile ulterioare nu mai găsesc obiectul; URL-ul oferă doar autorizare temporară, nu un snapshot.

```bash
aws s3api head-object --bucket BUCKET --key auctions/UUID/image
aws s3 cp ./image.jpg s3://BUCKET/auctions/UUID/image
aws s3 presign s3://BUCKET/auctions/UUID/image --expires-in 300
aws s3api delete-object --bucket BUCKET --key auctions/UUID/image
```

**Examene/capcane:** validarea MIME declarată nu validează conținutul; versioning + lifecycle pentru retenție/recuperare; `Retain` lasă bucket-ul în urmă la ștergerea stack-ului, iar fără `Retain` un bucket ne-gol blochează ștergerea pentru că CloudFormation nu șterge obiectele; CORS S3 este separat de CORS API.

## 8. EventBridge Scheduler

**Rol:** pornește evenimente după timp. Aici o regulă la 5 minute invocă expiration Lambda; nu există un cron per licitație.

```yaml
Type: AWS::Events::Rule
Properties:
  ScheduleExpression: rate(5 minutes)
  State: ENABLED
  Targets:
    - Arn: !GetAtt ExpirationLambdaFunction.Arn
      Id: expiration
```

Plus `AWS::Lambda::Permission` care permite `events.amazonaws.com` să invoce funcția. Scheduler/cron nu garantează execuție exact la `endDate` și livrarea este cel puțin o dată.

```bash
aws events list-rules
aws events list-targets-by-rule --rule RULE_NAME
aws events disable-rule --name RULE_NAME
aws events enable-rule --name RULE_NAME
```

**Examene/capcane:** `rate(5 minutes)` nu este `cron(...)`; permisiunea de invocare este obligatorie; handler-ul trebuie idempotent pentru retry/duplicate.

## 9. SQS + DLQ

**Rol:** buffer durabil care decuplează închiderea de trimiterea emailului. Queue, message, producer, consumer, visibility timeout, retention, redrive policy și DLQ.

1. Expiration trimite mesajul cu auction/winner.
2. Poller-ul Lambda îl preia; mesajul devine invizibil temporar.
3. Handler reușit → Lambda șterge mesajul.
4. Handler eșuat/timeout → mesajul reapare și se reia.
5. După `maxReceiveCount` → DLQ pentru investigație, nu pierdere automată.

```yaml
MessageRetentionPeriod: 345600 # 4 zile
VisibilityTimeout: 180
RedrivePolicy:
  deadLetterTargetArn: !GetAtt WinnerNotificationsDLQ.Arn
  maxReceiveCount: 5
```

**Producție:** DLQ + alarmă, visibility timeout > Lambda timeout, consumer idempotent, batch parțial raportat, retention conform recuperării. Standard queue = cel puțin o dată și ordine best effort; FIFO = deduplicare/ordine în grup, throughput și denumiri diferite.

```bash
aws sqs send-message --queue-url QUEUE_URL --message-body '{"auctionId":"UUID"}'
aws sqs receive-message --queue-url QUEUE_URL
aws sqs get-queue-attributes --queue-url QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws sqs purge-queue --queue-url DLQ_URL # distructiv: numai după analiză explicită
```

## 10. SES

**Rol:** trimite email. Identity verificată = domeniu sau adresă; sandbox limitează destinatarii la identități verificate.

- Sandbox: expeditor și destinatar verificați; production access scoate limitarea destinatarilor, nu obligativitatea unui expeditor verificat.
- Pentru producție verifică domeniul (DKIM), configurează MAIL FROM/SPF după necesitate, gestionează bounce/complaint; nu verifici manual fiecare utilizator.
- HTML + text alternativ; linkurile și datele utilizatorului trebuie escapate; nu trimite secrete prin email.

```bash
aws sesv2 list-email-identities
aws sesv2 get-email-identity --email-identity EMAIL_OR_DOMAIN
aws sesv2 create-email-identity --email-identity EMAIL_OR_DOMAIN
aws sesv2 get-account
```

**Examene/capcane:** IAM `ses:SendEmail` autorizează apelul, dar nu scoate sandbox-ul; spam nu înseamnă că SES a eșuat; SNS nu este serviciul de email tranzacțional aici.

## 11. IAM

**Rol:** autentificare/autorizare AWS. Policy = statements cu `Effect`, `Action`, `Resource`, opțional `Condition`. Lambda execution role are trust policy pentru `lambda.amazonaws.com`.

```yaml
Effect: Allow
Action: [s3:GetObject, s3:PutObject, s3:DeleteObject]
Resource: !Sub '${AuctionImagesBucket.Arn}/auctions/*'
```

- API Lambda ≠ expiration Lambda ≠ notification Lambda: roluri și permisiuni minime separate.
- Resurse: obiect S3 `/auctions/*`, nu întreg bucket-ul; SQS doar queue-ul necesar; DynamoDB acțiuni doar pe tabel/index.
- Evaluare: deny explicit câștigă; implicit deny; identitate + resource policy + boundaries/SCP după context.

```bash
aws sts get-caller-identity
aws iam get-role --role-name ROLE_NAME
aws iam list-attached-role-policies --role-name ROLE_NAME
aws iam simulate-principal-policy --policy-source-arn ROLE_ARN --action-names s3:GetObject
```

**Examene/capcane:** IAM role pentru servicii, access keys nu în Lambda/env/repo; wildcard la acțiuni sau resurse nu este least privilege; autorizarea SES nu verifică identitățile în locul SES.

## 12. CloudWatch Logs, Metrics și Alarms

**Rol:** Logs = evenimente; Metrics = serii numerice; Alarms = prag + acțiune; Insights = interogare loguri.

```bash
aws logs tail /aws/lambda/FUNCTION --since 15m --follow
aws logs filter-log-events --log-group-name /aws/lambda/FUNCTION \
  --start-time EPOCH_MS --filter-pattern 'auctionId'
aws logs start-query --log-group-name /aws/lambda/FUNCTION \
  --start-time EPOCH_SECONDS --end-time EPOCH_SECONDS \
  --query-string 'fields @timestamp, @message | sort @timestamp desc | limit 20'
aws cloudwatch describe-alarms --alarm-names ALARM_NAME
```

**Producție:** retenție explicită (14 zile aplicație, 90 audit), JSON metadata + request/auction ID, loguri și la erori, fără JWT/body/PII. Alarme utile: Lambda errors/duration/throttles, DLQ > 0, vechimea mesajelor SQS.

**Examene/capcane:** un log de succes pentru Lambda API nu dovedește jobul cron; verifică fiecare funcție separat; metrica `Invocations` nu garantează succes; DLQ gol nu dovedește că toate emailurile au fost livrate.

## 13. Debugging pragmatic: urmărește ID-ul, nu presupune

1. `POST` răspunde 201 → salvează `auctionId`; deschide `imageUrl` imediat.
2. `GET` arată `imageUrl` la ACTIVE → API poate semna; nu dovedește existența obiectului fără `HeadObject`/deschidere.
3. După deadline + interval cron → `GET` trebuie CLOSED, fără `imageUrl`.
4. Logs expiration: a găsit/închis itemul? Logs S3: ștergerea a reușit? Logs notification: a consumat mesajul?
5. SQS depth + DLQ + SES identity → separă „nu s-a trimis” de „a ajuns în spam”.
6. Retry/duplicate: al doilea close nu trimite alt email; al doilea delete este inofensiv; bid și close folosesc condiții DynamoDB.

**Ordinea corectă:** observă eroarea → formulează ipoteza → verifică o singură frontieră (API, DynamoDB, S3, cron, SQS, SES) → schimbă o singură variabilă → repetă testul → adaugă regresie automată.
