# AWS Developer prin proiectul Serverless Auctions

Ghid de studiu în română pentru serviciile folosite efectiv în repository. Citește-l în ordine, apoi refă fluxurile în consolă/CLI într-un stage izolat. O singură lectură oferă harta conceptuală; competența pentru AWS Developer vine și din laboratoare, citirea documentației oficiale și exersarea scenariilor de examen.

> Toate comenzile care încep cu `aws` comunică cu un cont real. Folosește un stage `dev` sau `benchmark-*`, credențiale cu drepturi minime și buget de siguranță. Domeniile `example.com` sunt exemple rezervate, nu adrese ale proiectului.

## 1. Harta completă

```text
Client
  │ HTTPS; JWT la mutații
  ▼
Route53 alias opțional → CloudFront → WAF + ACM opțional
                          │ Lambda@Edge origin-request citește SecureString
                          │ și adaugă header-ul x-auctions-edge-key
                          ▼
                    API Gateway HTTP API
                          │ Cognito JWT authorizer
                          ▼
                      Lambda api
                    ┌─────┼──────────┐
                    ▼     ▼          ▼
                DynamoDB  S3         SQS health
                          │
EventBridge → Lambda expiration ─────┤
                    │                 │
                    ├─ DynamoDB       ▼
                    ├─ S3       WinnerNotificationsQueue
                    │                 │
                    │                 ▼
                    │          Lambda notification
                    │            ├─ DynamoDB idempotency
                    │            └─ SES email
                    ▼
             DLQ-uri → CloudWatch alarms → SNS → email operator

SSM leagă stack-urile; KMS propriu este opțional; CloudWatch Logs/EMF observă tot.
```

> Profilul cost-safe al acestui repository ține PITR, cheia KMS proprie, WAF-ul, ACM și Route 53 oprite implicit. Fiecare este opt-in prin variabilele `DYNAMODB_PITR_ENABLED`, `LAMBDA_CMK_ENABLED`, `WAF_ENABLED` și `PROD_CUSTOM_DOMAIN_ENABLED`. Explicațiile linie cu linie și tabelul de costuri sunt în `docs/aws-learning-guide.md`.

Trei fișiere, trei responsabilități:

- `infra.yml`: date și identitate, regiunea `eu-central-1`;
- `api.yml`: compute și HTTP, aceeași regiune; scrie `/api/id` în SSM;
- `edge.yml`: CloudFront + Lambda@Edge, obligatoriu `us-east-1`; citește `/api/id` din SSM după ce `scripts/sync-edge-contract.sh` îl copiază în acea regiune.

## 2. Cont, regiune, ARN și cost

**Cont AWS** izolează resurse și facturare. **Regiunea** este o zonă geografică de clustere de disponibilitate. **AZ** este o locație izolată din regiune. Unele servicii sunt regionale (Lambda, DynamoDB, SQS), iar CloudFront este global cu puncte de prezență; WAF-ul său și ACM-ul distribuției se configurează în `us-east-1`.

**ARN** identifică o resursă:

```text
arn:partition:service:region:account-id:resource
arn:aws:dynamodb:eu-central-1:123456789012:table/auctions
```

ARN nu este URL. Queue URL identifică coada pentru API-ul SQS; Queue ARN este folosit în IAM și event source mapping. Bucket-ul are nume global unic; obiectele au chei.

Înainte de laborator:

1. Activează MFA pentru root și nu folosi root la lucru zilnic.
2. Folosește IAM Identity Center/roluri, nu access keys în repository.
3. Creează buget și alerte; bugetul notifică, nu oprește automat costurile.
4. Verifică regiunea în fiecare comandă.
5. Șterge numai resursele create de laborator, după ce înțelegi retenția.

Free Tier este o cotă condiționată de serviciu, vechimea contului și regiune, nu înseamnă „serverless gratuit”. CloudFront, WAF, NAT, ACM privat, KMS, log ingestion/storage și restore-urile pot avea reguli diferite. Consultă pagina oficială de preț înainte de teste mari.

```bash
# Confirmă contul și identitatea folosită de CLI; nu afișează secrete.
aws sts get-caller-identity
```

## 3. IAM: cine are voie să facă ce

**Principal** cere o acțiune pe o resursă. **Policy** JSON conține `Effect`, `Action`, `Resource` și opțional `Condition`. **Role** are o trust policy: cine poate asuma rolul. Lambda primește temporary credentials prin execution role.

Evaluarea pornește de la implicit deny; un allow trebuie să existe, iar explicit deny câștigă. În cont și organizație pot interveni resource policies, permission boundaries și SCP.

```yaml
Effect: Allow
Action:
  - dynamodb:UpdateItem
Resource: arn:aws:dynamodb:eu-central-1:123456789012:table/auctions
Condition:
  StringEquals:
    aws:RequestedRegion: eu-central-1
```

În proiect, API, expiration și notification au roluri separate. `dynamodb:Query` pe tabel nu acoperă automat GSI: IAM include și `/index/...`. S3 separă operația pe bucket de cea pe obiect.

Wildcard nu este automat greșit, dar trebuie justificat: `auctions/*` acoperă chei dinamice; log streams sunt generate de Lambda. SES are excepția documentată `Resource: '*'` și condiție pe `ses:FromAddress`.

```bash
# Simulează o acțiune pentru rol; rezultatul depinde de politicile reale ale contului.
aws iam simulate-principal-policy \
  --policy-source-arn ROLE_ARN \
  --action-names dynamodb:DescribeTable \
  --resource-arns TABLE_ARN
```

**Capcană examen:** autentificarea Cognito a utilizatorului nu dă execution role-ului Lambda permisiuni. Sunt două planuri de autorizare diferite.

## 4. CLI, JSON și JMESPath

AWS CLI trimite semnat cereri API. `--region` alege endpoint-ul, `--output json/table/text` formatează rezultatul, iar `--query` folosește JMESPath pentru filtrare.

```bash
# Afișează doar numele și ARN-ul tabelelor; nu modifică nimic.
aws dynamodb list-tables --region eu-central-1 \
  --query 'TableNames' --output table
```

Git Bash poate transforma căile care încep cu `/`. Prefixează comenzile cu nume SSM/log group:

```bash
MSYS_NO_PATHCONV=1 aws ssm get-parameter \
  --name /nestjs-aws-serverless/dev/auctions/table-name \
  --query Parameter.Value --output text
```

Nu pune parole direct în istoric shell pentru sisteme reale. Pentru exerciții locale folosește credențiale unice, iar pentru automatizări citește secrete printr-un mecanism sigur.

## 5. YAML, Serverless Framework și CloudFormation

YAML declară configurația. Serverless Framework rezolvă variabile și generează CloudFormation. CloudFormation creează/actualizează resursele și urmărește starea într-un **stack**.

| Expresie | Semnificație |
|---|---|
| `${sls:stage}` | stage-ul Serverless |
| `${self:custom.project}` | valoare din configurația proprie |
| `${env:NAME, 'default'}` | variabilă de mediu cu fallback |
| `${ssm:/path}` | citire SSM la rezolvare |
| `${file(...):LogicalId}` | include o resursă externă |
| `!Ref X` | valoarea specifică returnată de resursa X |
| `!GetAtt X.Arn` | atributul ARN al resursei |
| `!Sub` | interpolare CloudFormation |
| `!If` / `Condition` | resurse sau valori condiționate |
| `DeletionPolicy: Retain` | păstrează resursa la delete stack |

`Ref` nu merge între stack-uri. Aici SSM transportă identificatorii; alternativa ar fi Outputs + `Fn::ImportValue`.

În liste YAML inline, pune variabilele Serverless între ghilimele:

```yaml
# Corect: colonul din variabilă nu este interpretat ca sintaxă YAML.
UseCustomDomain: !Equals ['${self:custom.customDomain}', true]
```

```bash
# Package generează local artefacte; deploy modifică contul.
npx sls package --config infra.yml --stage dev
npx sls deploy --config infra.yml --stage dev

# Inspectează starea și resursele unui stack real.
aws cloudformation describe-stacks --stack-name nestjs-aws-serverless-infra-dev
aws cloudformation list-stack-resources --stack-name nestjs-aws-serverless-infra-dev
```

**Change set** previzualizează schimbarea. **Replacement** poate înlocui fizic resursa. **Retain** nu este backup. Pentru stateful, citește change set-ul înainte de apply.

## 6. SSM Parameter Store și KMS

SSM păstrează configurație. `String` este potrivit pentru nume/ARN/URL; `SecureString` pentru valori secrete. KMS criptează datele; IAM decide cine poate decripta.

SSM este **regional**. Dacă un stack citește `/nestjs-aws-serverless/prod/api/id` în `us-east-1`, parametrul trebuie să existe acolo, nu doar în `eu-central-1`. `scripts/sync-edge-contract.sh` copiază acest identificator ne-secret între regiuni.

CloudFormation **nu acceptă** `{{resolve:ssm-secure:...}}` în `AWS::CloudFront::Distribution` → `Origins`. Soluția din proiect este o funcție Lambda@Edge `origin-request` care citește SecureString-ul din SSM și adaugă header-ul la runtime; astfel secretul nu ajunge în template.

Proiectul publică parametri sub `/nestjs-aws-serverless/{stage}/`. `configure-secrets.sh` scrie expeditorul SES și secretul de origin fără să îi afișeze. Lambda citește SecureString la bootstrap, o dată per execution environment.

```bash
# Scrie un String ne-secret; --overwrite modifică valoarea existentă.
aws ssm put-parameter --name /demo/config --value demo --type String --overwrite

# Citește fără decriptare un identificator; nu folosi exemplul pentru a afișa secrete.
aws ssm get-parameter --name /demo/config --query Parameter.Value --output text
```

KMS distinge cheia, key policy, grant și operațiile `Encrypt`/`Decrypt`/`GenerateDataKey`. Rotația automată schimbă materialul viitor, dar KMS păstrează materialul pentru datele vechi. `kmsKeyArn` pe Lambda criptează variabilele de mediu; nu criptează automat logurile sau body-ul aplicației.

## 7. Lambda

Lambda rulează un handler pe un runtime, cu memorie, timeout, execution role și event source. Memoria influențează și CPU. ARM64 poate reduce costul dacă toate binarele sunt compatibile.

**Cold start:** mediu nou + inițializare cod. **Warm start:** același mediu reutilizează obiectele din afara handler-ului. Nu păstra date de utilizator în variabile globale.

```typescript
const client = new DynamoDBClient({}); // reutilizat la warm
export async function handler(event: unknown) {
  await client.send(new DescribeTableCommand({ TableName: 'example' }));
}
```

Sincron, clientul primește eroarea. Asincron, platforma poate reîncerca. SQS Lambda poller citește batch-uri și șterge mesajele confirmate. `reservedConcurrency: 1` serializează expirarea, dar nu este un mecanism general de idempotență.

Proiectul folosește un layer comun și ZIP-uri mici. Sharp este instalat pentru Linux ARM64/glibc, independent de Windows-ul developerului.

```bash
# Citește configurația reală; invocarea separată poate produce efecte și cost.
aws lambda get-function-configuration --function-name FUNCTION_NAME
aws lambda invoke --function-name FUNCTION_NAME --payload '{}' response.json
```

**Capcane:** timeout Lambda trebuie mai mic decât SQS visibility timeout; retry externe au nevoie de propriul timeout; mai multă memorie nu este automat mai ieftină; un layer nu reduce dimensiunea totală a dependențelor, doar pachetul funcției.

## 8. API Gateway HTTP API și Cognito

HTTP API primește HTTPS, aplică rute/authorizer și invocă Lambda. Payload v2 conține `rawPath`, `requestContext.http` și claims JWT. Throttling-ul actual este 100 req/s și burst 200.

Cognito User Pool este director și emitent OIDC. App Client definește flow-ul. Hosted UI oferă paginile de login. Proiectul are client public authorization code, deci `GenerateSecret: false`.

- **ID token:** identitate pentru client/API; aici furnizează `sub` și `email`;
- **access token:** acces/scopes;
- **refresh token:** reînnoire, nu Bearer pentru API;
- authorizer verifică semnătura, issuer, audience și expirarea;
- ownership-ul rămâne responsabilitatea aplicației.

```bash
# Inspectează configurația API, fără tokenuri în output.
aws apigatewayv2 get-routes --api-id API_ID
aws apigatewayv2 get-authorizers --api-id API_ID
```

CORS este control al browserului, nu autentificare. `allowCredentials: true` cere origini exacte. JWT nu înlocuiește validarea DTO sau condiția `createdBy = caller.sub`.

## 9. DynamoDB și GSI

DynamoDB este NoSQL cu cheie primară. **Partition key** este obligatorie; **sort key** este opțională. **Item** este documentul, iar atributele sunt tipate.

| Operație | Când o folosești |
|---|---|
| `GetItem` | cheie primară completă |
| `Query` | o partition key + condiții pe sort key |
| `Scan` | parcurgere costisitoare; filtrarea este după citire |
| `PutItem` | create/replace, ideal condiționat |
| `UpdateItem` | update atomic și condiții de concurență |
| `BatchWriteItem` | mai multe scrieri, nu tranzacție |
| `TransactWriteItems` | invariant atomic peste mai multe operații |

**GSI** are altă cheie și este eventual consistent. **LSI** are aceeași partition key și se definește la crearea tabelului. Proiecția `ALL/KEYS_ONLY/INCLUDE` influențează datele returnate și costul.

```yaml
BillingMode: PAY_PER_REQUEST
KeySchema:
  - { AttributeName: id, KeyType: HASH }
GlobalSecondaryIndexes:
  - IndexName: status-endDate-v2-index
    KeySchema:
      - { AttributeName: status, KeyType: HASH }
      - { AttributeName: endDate, KeyType: RANGE }
```

Condițiile protejează regulile: `status=ACTIVE` la close, `createdBy=sub` la update și amount mai mare la bid. `ConditionalCheckFailedException` este rezultat de business, nu neapărat outage.

`PAY_PER_REQUEST` elimină capacity planning de bază, nu costul Scan-urilor. Paginarea folosește `LastEvaluatedKey`/`ExclusiveStartKey`; cursorul API este opac.

PITR oferă restore până la 35 zile. TTL șterge asincron și nu este scheduler exact. În proiect, licitațiile CLOSED primesc `expiresAt` la 90 zile, iar tombstone-urile COMPLETED la 30 zile.

```bash
aws dynamodb query --table-name TABLE --index-name status-endDate-v2-index \
  --key-condition-expression '#s = :active' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":active":{"S":"ACTIVE"}}'
```

## 10. S3 și URL-uri semnate

S3 stochează obiecte: bucket + key + bytes + metadata. Prefixul `auctions/` nu este director. Bucket Public Access Block are patru controale distincte; proiectul le activează pe toate.

URL-ul pre-signed împrumută temporar permisiunea semnatarului. Nu face bucket-ul public, nu copiază obiectul și nu supraviețuiește ștergerii obiectului. Aici este numai pentru GET, 300 secunde, cu response WebP și Content-Disposition.

Upload-ul trece prin API: fișier maximum 5 MiB, semnătură reală JPEG/PNG/WebP, maximum 40 MP. Sharp rotește după EXIF, elimină metadata și scrie WebP + thumbnail. Originalul nu ajunge în S3.

```bash
# HeadObject verifică existența/metadatele fără descărcarea body-ului.
aws s3api head-object --bucket BUCKET --key auctions/UUID/image.webp
```

**Capcane:** MIME declarat nu validează bytes; `DeleteObject` este idempotent; bucket ne-gol poate bloca ștergerea CloudFormation dacă nu este Retain; S3 CORS și API CORS sunt configurații diferite.

## 11. SQS, SNS și DLQ

SQS este coadă point-to-point; un mesaj este consumat de un worker. SNS este pub/sub și distribuie către abonați. Aici SNS trimite alertele operatorului, nu emailul câștigătorului.

Concepte SQS:

- **visibility timeout:** mesaj preluat devine temporar invizibil;
- **retention:** cât rămâne mesajul;
- **redrive policy:** după `maxReceiveCount`, merge în DLQ;
- **DLQ:** stochează eșecuri pentru analiză, nu le repară;
- **long polling:** reduce răspunsurile goale;
- **Standard:** at-least-once, best-effort ordering;
- **FIFO:** ordine/deduplicare în grup, cu API și throughput diferite.

`ReportBatchItemFailures` reîncearcă numai ID-urile raportate. Idempotența aplicației este în continuare necesară pentru duplicate după succes sau pentru efecte externe.

```bash
# Citește depth și vârsta; nu modifica mesajele.
aws sqs get-queue-attributes --queue-url QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateAgeOfOldestMessage
```

**Nu folosi `purge-queue` ca procedură de debugging.** Redrive după corectarea cauzei; purge distruge dovezi și date.

## 12. SES

SES trimite email tranzacțional. Identity poate fi adresă sau domeniu verificat. Sandbox limitează destinatarul la identități verificate/simulator; production access ridică limitarea, dar expeditorul trebuie tot verificat.

Simulatorul folosește adrese precum `success@simulator.amazonses.com` pentru teste fără email real. DKIM ajută autentificarea domeniului; bounce și complaint trebuie monitorizate. HTML trebuie escapat și însoțit de text alternativ.

Proiectul adaugă timeout, retry numai pentru erori tranzitorii, backoff cu jitter și circuit breaker. Toate pot produce duplicate dacă rezultatul SES este ambiguu, de aceea există claim-ul DynamoDB.

```bash
# SESv2 inspectează identitățile; CLI-ul aplicației folosește SDK SES v1 SendEmail.
aws sesv2 list-email-identities --region eu-central-1
aws sesv2 get-account --region eu-central-1
```

## 13. EventBridge

EventBridge Rule cu `ScheduleExpression: rate(5 minutes)` invocă expiration. `AWS::Lambda::Permission` permite serviciului `events.amazonaws.com` să invoce funcția pe acel SourceArn.

Schedule nu este exact la `endDate` fiecărei licitații: se execută la următorul tick plus latența GSI. Retry-ul și livrarea cel puțin o dată cer close condiționat.

Target DLQ acoperă imposibilitatea livrării evenimentului către target. SQS consumer DLQ acoperă procesarea mesajului. Sunt căi de eșec distincte și au alarme distincte.

```bash
aws events list-rules --region eu-central-1
aws events list-targets-by-rule --rule RULE_NAME --region eu-central-1
```

## 14. CloudWatch Logs, Metrics, EMF și Alarms

**Log group** conține log streams. Retenția aplicației este 14 zile. Lambda adaugă START/END/REPORT, iar aplicația adaugă JSON cu correlation ID.

**Metric** este o serie numerică. **Alarm** evaluează o metrică pe perioade și poate apela SNS. `TreatMissingData: notBreaching` evită alarma când nu sunt invocări.

**EMF** este JSON special în Logs din care CloudWatch generează metrici; nu este același lucru cu logul JSON obișnuit. Powertools publică metricile business în namespace `Auctions`.

Alarmele proiectului: depth > 0 și age > 300s pentru ambele DLQ-uri, plus Errors/Throttles pentru expiration/notification. Nu există alarmă care să dovedească livrarea în inbox.

```bash
# Tail este pentru observație live; Ctrl+C oprește urmărirea.
MSYS_NO_PATHCONV=1 aws logs tail /aws/lambda/FUNCTION --follow

# Describe arată starea și motivul alarmei.
aws cloudwatch describe-alarms --alarm-names ALARM_NAME
```

## 15. CloudFront, WAF, ACM și Route53

**CloudFront** este CDN și HTTPS edge. Aici cache-ul API este dezactivat, compresia este activată și origin-ul este API Gateway. Headerul secret de origin reduce bypass-ul direct; nu îl loga.

**WAF** filtrează cereri. Regula rate-based limitează per IP; managed SQLi inspectează pattern-uri cunoscute. Nu înlocuiește validarea inputului sau parametrizarea accesului la date.

**Lambda@Edge** rulează în afara regiunii stack-ului, aproape de vizualizator. În acest proiect, funcția `origin-request` citește secretul din SSM `us-east-1` și adaugă `x-auctions-edge-key`. Are cost per invocare și nu are free tier separat; pentru volum mare, un CloudFront Function + KeyValueStore este alternativa mai ieftină. `OriginProtocolPolicy` se pune sub `CustomOriginConfig`, nu direct pe `Origins`.

**ACM** furnizează certificate. Pentru CloudFront certificatul este în `us-east-1`. DNS validation cere CNAME la provider; certificatul rămâne pending până la validare.

**Route53** oferă DNS. Hosted zone conține records. Alias A către CloudFront nu este un CNAME obișnuit. Resursele edge nu cumpără domeniu și nu creează hosted zone.

Procedură reală: domeniu propriu → activezi custom domain → creezi CNAME de validare → ACM ISSUED → CloudFormation finalizează → alias DNS → CORS/Cognito cu domeniul real → test HTTPS/JWT. `example.com` nu trebuie folosit pentru un deploy real.

## 16. Reziliență și scalabilitate

- **Idempotency:** aceeași comandă repetată nu produce efecte suplimentare controlabile;
- **lease:** permite reluarea după crash, cu token ca un worker vechi să nu termine munca altuia;
- **timeout:** oprește așteptarea infinită;
- **retry + backoff + jitter:** tratează erori tranzitorii fără sincronizarea tuturor clienților;
- **circuit breaker:** oprește temporar apelurile către o dependență care eșuează;
- **DLQ:** păstrează lucrul nereușit pentru om;
- **backpressure/concurrency:** limitează câți consumatori apasă dependențele;
- **graceful shutdown:** eliberează resurse la semnal, dar nu amână scrieri critice până la oprire.

Niciun mecanism nu oferă singur exactly-once peste DynamoDB + SQS + SES. Sistemul folosește condiții, markeri durabili și recuperare explicită.

## 17. Deploy și rollback în trei stack-uri

```bash
# 1. Stateful; ALERT_EMAIL și CORS trebuie configurate în mediu înainte.
npx sls deploy --config infra.yml --stage dev

# 2. Scrie SecureStrings reale prin script, apoi compute.
bash scripts/configure-secrets.sh
npx sls deploy --config api.yml --stage dev

# 3. Edge; citește mai întâi output-ul domeniului CloudFront.
npx sls deploy --config edge.yml --stage dev
```

Rollback = redeploy al versiunii anterioare API/edge, nu ștergerea infra. Datele noi trebuie să rămână compatibile cu codul vechi. Resursele Retain supraviețuiesc stack delete și pot continua să coste.

Nu șterge vechiul stack dev pentru a „migra”. Numele resurselor pot intra în conflict; folosește stage nou + export/import testat sau import CloudFormation revizuit.

## 18. Benchmark și decizii de cost

Scriptul testează 128, 256, 512 și 1024 MiB, cu cold/warm calls și rapoarte `Billed Duration`. Cere stage `benchmark-*` existent și confirmare, iar la final restaurează memoria.

```bash
# Operație reală, numai într-un stage izolat cu date de test.
npm run benchmark:lambda -- \
  --stage benchmark-auctions \
  --confirm-disposable-stage benchmark-auctions \
  --warm-invocations 3
```

Compară `cost_per_invocation_usd`, durata medie și cold start. Nu alege automat cea mai mică durată sau memorie. Prețul estimat exclude unele costuri auxiliare și trebuie actualizat după regiune/ARM.

Valorile actuale 512/256/256 MiB nu au fost măsurate în AWS în această sesiune.

## 19. Capcane AWS Developer — recapitulare

1. `Query` folosește cheia; `Scan` parcurge și filtrează după citire.
2. GSI este eventual consistent; nu îl folosi pentru citire imediată critică fără să accepți întârzierea.
3. Conditional write previne lost updates; validarea DTO singură nu previne concurența.
4. SQS Standard este at-least-once; DLQ nu face retry automat și nu repară payload-ul.
5. Visibility timeout trebuie să acopere procesarea și retry-urile configurate.
6. Partial batch response evită reprocesarea recordurilor reușite, dar nu elimină duplicatele posibile.
7. Lambda execution role ≠ Cognito user permissions.
8. Reserved concurrency limitează; nu scalează și nu este lock distribuit general.
9. S3 signed URL nu publică bucket-ul și nu păstrează obiectul după delete.
10. CORS nu este authentication și nu blochează clienții non-browser.
11. JWT validează identitatea/tokenul; ownership-ul este verificat separat.
12. SNS este pub/sub alerte; SQS este buffer; SES este email tranzacțional.
13. PITR ≠ TTL ≠ backup export; testează restore.
14. KMS criptează, IAM autorizează decriptarea; SecureString nu trebuie afișat în CLI/log.
15. CloudFront ACM/WAF pentru distribuție se configurează în `us-east-1`.
16. Budget alertează; nu întrerupe facturarea.
17. `Retain` păstrează resursa, dar nu garantează că poți restaura ușor datele.
18. Un health 200 al API-ului nu dovedește că schedule-ul sau consumerul funcționează.
19. Log de succes SES nu garantează inbox; verifică bounce/spam/sandbox.
20. Packaging reușit nu este deploy, iar deploy reușit nu este test de business end-to-end.

## 20. Plan de laborator și autoevaluare

Într-un cont de test, cu buget:

1. Desenează cele trei stack-uri și găsește fiecare SSM parameter.
2. Explică fiecare statement IAM și de ce resursa este exact aceea.
3. Creează doi utilizatori Cognito și demonstrează ownership + regula creator/bidder.
4. Creează o licitație, deschide imaginea și parcurge două pagini cu cursor.
5. Așteaptă expirarea și urmărește același `auctionId` prin toate cele trei funcții.
6. Trimite un duplicat după COMPLETED și demonstrează că nu apare al doilea email.
7. Trimite un payload invalid într-un stage izolat și observă DLQ + SNS.
8. Verifică health prin oprirea controlată a accesului într-un mediu de test, apoi restaurează.
9. Rulează benchmark-ul numai dacă bugetul permite și justifică memoria aleasă din CSV.
10. Explică de ce exactly-once SES nu este garantat și ce se întâmplă la crash după trimitere.

Poți considera că ai înțeles proiectul când poți răspunde fără ghid la: „unde se află datele?”, „ce se întâmplă la duplicat?”, „ce permisiune lipsește?”, „ce alarmă se aprinde?” și „cum restaurez fără să șterg datele?”.
