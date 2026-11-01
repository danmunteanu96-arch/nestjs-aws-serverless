# Arhitectură și operare — Serverless Auctions

## 1. Principii și limite

Aplicația este un monolit modular NestJS cu trei entry point-uri Lambda. Nu există ORM, cache sau broker suplimentar: DynamoDB, SQS și S3 acoperă cerințele actuale. Clienții AWS SDK sunt creați la nivel de modul și reutilizați între invocări calde.

Separarea stateful/stateless reduce riscul ca o actualizare API să înlocuiască datele. Totuși, `DeletionPolicy: Retain` nu este un backup și nu elimină necesitatea unui plan de restore.

Validat în AWS pe 2026-11-01: stack-urile `infra` și `api` sunt `UPDATE_COMPLETE`, `/health` răspunde 200 cu header-ul de origine și 403 fără el. Edge-ul CloudFront, livrarea SES, fluxul Postman complet și benchmark-ul se validează în continuare. Profilul implicit este cost-safe; resursele plătite (WAF, KMS propriu, PITR, ACM/Route 53) sunt opt-in.

## 2. Module și entry point-uri

```text
src/
  common/                 # logging, correlation ID, filter HTTP, decorator identity
  config/                 # validare Zod și încărcare SecureString
  http/                   # pipeline Express/Nest partajat
  infrastructure/         # clienți AWS și lifecycle
  modules/
    auctions/             # API, business rules, DTO, DynamoDB
    auctions/expiration/  # închidere și retry producer
    auctions/images/      # validare, Sharp, S3, URL semnat
    health/               # readiness DynamoDB + SQS
    notifications/        # SQS batch, idempotență, SES, DLQ
  lambda.ts               # HTTP Lambda
  auction-expiration.ts   # scheduled Lambda
  winner-notification.ts  # SQS Lambda
  main.ts                 # server local
```

Controller-ele validează contractul și deleagă. Regulile de business și condițiile DynamoDB sunt în servicii. Fiecare Lambda are rol IAM propriu.

`api.yml` compilează cu esbuild, minify și tree-shaking. AWS SDK este extern pentru runtime-ul Lambda, iar NestJS, Sharp și celelalte dependențe comune sunt în `CommonLambdaLayer`. Pluginul instalează Sharp pentru Linux ARM64/glibc chiar când packaging-ul pornește de pe Windows.

## 3. Stack-uri și contract SSM

### `infra.yml` — stateful

- `AuctionsTable`, on-demand, TTL pe `expiresAt`; PITR **oprit implicit** și activat numai cu `DYNAMODB_PITR_ENABLED=true`;
- `NotificationIdempotencyTable`, on-demand și TTL;
- bucket S3 privat, criptat, versionat, cu blocare acces public, abort multipart după 1 zi și expirare versiuni non-current după 7 zile;
- coada winner + DLQ și DLQ pentru targetul EventBridge;
- Cognito User Pool, Domain și public App Client;
- cheie KMS **opțională** pentru variabilele Lambda, creată numai cu `LAMBDA_CMK_ENABLED=true`;
- topic SNS, abonare email condiționată, buget și anomaly detection condiționate;
- parametri String pentru nume/ARN/URL-uri; secretele sunt SecureString separate.

### `api.yml` — stateless regional

- HTTP API cu throttling 100 req/s sustained și 200 burst;
- JWT authorizer Cognito;
- Lambda API 512 MiB, expiration 256 MiB, notification 256 MiB (valori inițiale, nu optimuri măsurate);
- expirare la fiecare 5 minute; concurență rezervată **opțională**, implicit dezactivată;
- SQS batch 10, fereastră 5 secunde, `ReportBatchItemFailures`;
- roluri IAM separate și opt alarme CloudWatch;
- SSM `/nestjs-aws-serverless/{stage}/api/id` pentru edge; parametrul este regional, deci `scripts/sync-edge-contract.sh` îl copiază în `us-east-1`.

### `edge.yml` — global prin `us-east-1`

- CloudFront cu compresie, HTTPS și cache dezactivat pentru API;
- WAF `CLOUDFRONT`, rate limit per IP și AWS Managed SQLi rule set — **opt-in** cu `WAF_ENABLED=true`;
- Lambda@Edge `origin-request` citește SecureString-ul din SSM și adaugă header-ul `x-auctions-edge-key`, verificat de `EdgeOriginGuard`; CloudFormation nu permite `ssm-secure` direct în `Origins`;
- ACM și Route53 alias numai când domeniul custom este activat explicit.

WAF pentru CloudFront și certificatul ACM pentru distribuție trebuie să fie în `us-east-1`, indiferent de regiunea API-ului.

## 4. Securitate

### IAM și secrete

Rolurile sunt în `iam/ApiRole.yml`, `iam/ExpirationRole.yml` și `iam/WinnerNotificationRole.yml`. Acțiunile sunt limitate la resursele necesare. Wildcard-urile pentru obiecte S3 și log streams sunt delimitate prin prefixul resursei. SES folosește `Resource: '*'` împreună cu condiția `ses:FromAddress`: API-ul SES nu permite delimitarea tuturor apelurilor la ARN-ul identității în același mod ca SQS/DynamoDB, deci expeditorul este controlul compensatoriu.

`SES_SENDER_EMAIL` și secretul CloudFront sunt scrise numai prin `scripts/configure-secrets.sh` ca `SecureString`. Lambda primește numele parametrilor, nu valorile, și le citește la bootstrap. Cognito App Client este public pentru authorization code flow: `GenerateSecret: false`; pool ID și client ID sunt identificatori, nu secrete.

Nu există Cognito client secret în proiect. Nu introduce unul fără un motiv de confidențialitate al clientului.

### Cognito și API

- MFA opțional prin TOTP, fără cost SMS;
- parolă minimum 12 caractere, cu majuscule, minuscule, cifre și simboluri;
- ID token 1 oră, access token 1 oră, refresh token 30 zile;
- callback/logout URL configurate per mediu;
- GET public; POST/PATCH protejate prin JWT;
- `sub` din JWT este identitatea, nu un ID din body;
- PATCH verifică ownership atomic; bid-urile folosesc condiții DynamoDB.

CORS folosește origini exacte din `CORS_ORIGINS` și `credentials: true`. Nu folosi `*` cu credentials. API Gateway răspunde la preflight; aplicația adaugă Helmet, CSP și compresie. JSON/urlencoded sunt limitate la 1 MiB, imaginea la 5 MiB.

### S3 și imagini

Originalul nu este stocat. Sharp elimină metadata, aplică orientarea EXIF și produce numai WebP redimensionat. Limita de 40 MP reduce riscul de decompression bombs, dar nu înlocuiește limita de bytes și timeout-urile.

Cheile sunt `auctions/{id}/image.webp` și `auctions/{id}/thumbnail.webp`. URL-ul de citire expiră după 300 secunde și forțează tipul WebP plus `Content-Disposition: inline`. Nu există URL pre-signed pentru upload; clientul trimite fișierul prin API.

## 5. Date, paginare și durabilitate

`GET /auctions` și `/active` returnează maximum 100 de elemente per pagină. `nextCursor` conține cheia de continuare DynamoDB și trebuie tratat ca valoare opacă. Lista nefiltrată poate folosi `Scan`, deci nu este potrivită pentru volume mari fără un access pattern suplimentar; IAM permite Scan doar pe tabelul exact.

GSI-urile actuale:

- `status-endDate-v2-index`: ACTIVE/expirare și listare după deadline;
- `notificationStatus-createdAt-index`: numai notificări PENDING;
- `status-createdAt-index`, `all-auctions-index`, `auctions-with-bids-index`: compatibilitate cu access pattern-urile existente.

La închidere se setează `expiresAt = now + 90 zile`. DynamoDB TTL șterge ulterior, fără garanție la o oră exactă. PITR este **oprit implicit** în profilul cost-safe; dacă îl activezi cu `DYNAMODB_PITR_ENABLED=true`, oferă restore într-o fereastră de până la 35 de zile. Testează procedura de restore numai într-un cont/stage de test.

Claim-urile `IN_PROGRESS` au lease 60 secunde și TTL 24 ore. Cele `COMPLETED` rămân 30 de zile pentru a bloca duplicatele tardive. TTL nu este mecanismul de idempotență; condițiile atomice sunt.

## 6. Închidere și notificări

1. EventBridge invocă expirarea.
2. Query GSI găsește ACTIVE cu `endDate <= now`.
3. Update condiționat schimbă statusul o singură dată, setează TTL și elimină `imageKey`.
4. Dacă există câștigător, `notificationStatus=PENDING` rămâne până la acceptarea SQS.
5. S3 șterge ambele derivate best-effort; o eroare poate lăsa un obiect orfan privat și este logată.
6. Producerul publică `{ auctionId, recipient, title, winningBid }`. Dacă SQS eșuează, următorul schedule reia PENDING.
7. Consumerul validează payload-ul cu Zod și procesează independent fiecare record.
8. Claim-ul DynamoDB blochează duplicatele finalizate; SES trimite emailul; `complete` este condiționat de tokenul claim-ului.
9. La eșec, fallback-ul trimite body-ul original în DLQ și eliberează claim-ul. Mesajul sursă este confirmat numai dacă DLQ acceptă mesajul.

SES are implicit 3 încercări, backoff exponențial cu jitter și timeout 5 secunde per încercare. După 3 eșecuri tranzitorii consecutive, circuitul se deschide pentru 30 secunde în acel execution environment. Nu este un circuit global distribuit.

Detaliile și cazul ambiguu „SES a trimis, dar Lambda a căzut înainte de complete” sunt în `SQS-FLOW-EXPLAINED.md`.

## 7. Health, logging și shutdown

`GET /health` este readiness, nu simplu liveness: execută în paralel `DescribeTable` și `GetQueueAttributes`, fiecare cu timeout. Returnează:

```json
{"status":"ok","checks":{"dynamodb":"up","sqs":"up"}}
```

Dacă una eșuează, returnează 503 cu același contract și `status: error`, fără mesaje provider.

Loggerul emite câte un JSON per linie cu `level`, `service`, `timestamp`, `message` și `correlationId`. Cheile sensibile sunt redactate înainte de serializare; codul nu trebuie să logheze body, headers, tokenuri sau destinatari. Metricile business sunt publicate prin Embedded Metric Format în namespace `Auctions`.

Toate entry point-urile activează shutdown hooks. `AwsClientLifecycle` distruge idempotent clienții la semnalul de oprire Nest. Clienții nu sunt distruși între invocări calde. Lambda poate opri mediul fără o perioadă lungă de graceful shutdown, deci scrierile importante nu se amână pentru SIGTERM.

## 8. Alarme și recuperare

Opt alarme trimit la SNS:

- mesaje vizibile > 0 și vârstă > 300 secunde pentru fiecare DLQ;
- Errors > 0 și Throttles > 0 pentru expiration și notification.

`TreatMissingData: notBreaching` evită alarme când nu există invocări. O alarmă DLQ necesită inspecție, nu `purge`. Păstrează mesajul, correlation/auction ID și logurile înainte de redrive. EventBridge are DLQ separat pentru eșecul livrării către Lambda; acesta nu este același lucru cu DLQ consumerului.

Bugetul implicit este 5 USD cu notificare la 80% (adică 4 USD), iar anomaly subscription are prag 10 USD; ambele sunt create numai cu `ALERT_EMAIL`. Valorile sunt configurabile și **nu garantează oprirea cheltuielilor**. Alerta de buget este doar o notificare; pentru profilul de curs cu credit mic, verifică pagina Billing și rulează teardown-ul din `docs/aws-learning-guide.md` după experimente.

## 9. Domeniu custom, ACM și DNS

Domeniile `api.auctions.example.com` și `app.auctions.example.com` sunt exemple rezervate, nu infrastructură existentă.

Procedura reală:

1. Ai un domeniu și o hosted zone Route53 sau un DNS provider la care poți crea CNAME.
2. Setează `PROD_API_DOMAIN=api.domeniul-tau.real` și, pentru Route53, `PROD_HOSTED_ZONE_ID`.
3. Activează `PROD_CUSTOM_DOMAIN_ENABLED=true` și pornește deploy-ul edge.
4. Din consola/CLI ACM în `us-east-1`, citește CNAME-urile de validare și creează-le la DNS provider. `DomainValidationOptions` nu înseamnă că orice DNS provider este configurat automat.
5. Așteaptă validarea ACM și finalizarea CloudFormation; nu șterge CNAME-ul de validare cât timp certificatul trebuie reînnoit.
6. Pentru Route53, resursa `EdgeDnsRecord` creează aliasul A către CloudFront. Pentru alt provider, creează echivalentul acceptat de acesta.
7. Actualizează CORS și Cognito callback/logout cu domeniile reale și testează HTTPS + JWT.

ACM pentru CloudFront nu este același lucru cu un certificat regional API Gateway. Nu activa DNS spre o distribuție înainte ca certificatul să fie validat.

## 10. Packaging, benchmark și rollback

```bash
# Packaging local infra; nu creează resurse.
npx sls package --config infra.yml --stage prod

# API/edge necesită parametrii SSM creați de infra/api într-un stage real.
npx sls package --config api.yml --stage prod
# Copiază /api/id din eu-central-1 în us-east-1 înainte de edge.
bash scripts/sync-edge-contract.sh prod
npx sls package --config edge.yml --stage prod

# Verifică ZIP-urile generate de API; obiectiv < 5 MiB per funcție.
npm run verify:artifacts
```

Fără SSM, API/edge packaging trebuie să eșueze. Nu adăuga fallback-uri false pentru a masca configurarea lipsă.

Benchmark-ul din `scripts/benchmark-lambda-memory.sh` cere un stage `benchmark-*` existent și confirmare repetată. CSV-ul `invocations.csv` păstrează fiecare măsurătoare, iar `summary.csv` agregă durata și costul estimat. Prețurile pot fi suprascrise prin `LAMBDA_ARM_PRICE_PER_GB_SECOND` și `LAMBDA_REQUEST_PRICE`; verifică pagina oficială de prețuri pentru regiune și arhitectură.

Rollback-ul codului se face către o versiune API/edge cunoscută, fără ștergerea stack-ului infra. O rollback de schemă nu șterge câmpurile noi: versiunea veche trebuie să tolereze `expiresAt`, `notificationStatus` și tabelul de idempotență. Resursele Retain rămân după ștergerea stack-ului și pot deveni resurse orfane tarifate.

Pentru vechiul stack dev, nu șterge tabelul/bucket-ul/User Pool-ul. Preferă un stage nou, export/import de date testat și comutare controlată. Importul resurselor existente într-un stack nou este un proiect separat, cu change set și backup.
