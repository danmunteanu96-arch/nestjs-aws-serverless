# SQS în proiectul Serverless Auctions — explicație completă

> **Notă:** acest fișier e doar pentru uz local (documentație de învățare).
> NU se commit-uiește. Documentația oficială a commitului este în
> `docs/commits/2026-10-21-sqs-winner-notifications.md`.

## 1. De la ce pornește și unde se termină — lanțul complet

```text
[START] EventBridge Scheduler (rate: 5 minute) — cron automat AWS
   │  declanșează
   ▼
Lambda: closeExpiredAuctions  (src/auction-expiration.ts)
   │  rol IAM: AuctionsExpirationRole
   │  1. Query pe DynamoDB GSI `status-endDate-v2-index`:
   │     toate licitațiile ACTIVE cu endDate <= acum
   │  2. Pentru fiecare: UpdateItem CONDIȚIONAT (status: ACTIVE → CLOSED)
   │     — condiția garantează că o licitație se închide o singură dată
   │  3. Dacă licitația are highestBidderEmail → SendMessage în SQS
   │     cu body JSON: { auctionId, recipient, title, winningBid }
   │  ⚠️ Aici se OPREȘTE responsabilitatea producerului.
   ▼
SQS: WinnerNotificationsQueue  (resources/WinnerNotificationsQueueResource.yml)
   │  - mesajul e stocat replicat, nu se pierde (retention 4 zile)
   │  - visibility timeout 60s: cine ia mesajul îl "blochează" pt. ceilalți
   │  - redrive policy: după 3 procesări eșuate → DLQ
   │  declanșează (prin event source mapping — Lambda service face polling)
   ▼
Lambda: sendWinnerNotification  (src/winner-notification.ts)
   │  rol IAM: WinnerNotificationRole
   │  1. Primește SQSEvent cu max 10 mesaje (batchSize)
   │  2. Pentru fiecare record: JSON.parse(body) → WinnerNotificationService
   │  3. Trimite email HTML + text prin SES
   │  4a. Succes → mesajul e șters automat din coadă
   │  4b. Eroare (throw) → mesajul reapare în coadă după visibility timeout
   ▼
[SUCCES] Gmail: inbox/spam la câștigător
[EȘEC × 3] SQS: WinnerNotificationsDLQ (retention 14 zile) — investigație manuală
```

## 2. Componentele SQS și cum se leagă de cod

| Componentă AWS | Unde e definită | Rol |
|---|---|---|
| `WinnerNotificationsQueue` | `resources/WinnerNotificationsQueueResource.yml` | bufferul dintre producer și consumer |
| `WinnerNotificationsDLQ` | același fișier | "coșul" mesajelor care eșuează de 3 ori |
| `AuctionsExpirationRole` → `sqs:SendMessage` | `iam/AuctionTableIAM.yml` | producerul poate DOAR pune mesaje |
| `WinnerNotificationRole` → `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` + `ses:SendEmail` | același fișier | consumerul poate DOAR citi/șterge din coadă și trimite email |
| Event source mapping | `serverless.yml` → `functions.sendWinnerNotification.events[sqs]` | lipiciul: spune lui Lambda să polleze coada |
| `SQSClient` | `src/infrastructure/sqs/sqs.module.ts` | clientul SDK injectat în producer |
| `WINNER_NOTIFICATIONS_QUEUE_URL` | `serverless.yml` provider.environment + `src/config/configuration.module.ts` | URL-ul cozii, injectat automat prin `Ref` |

## 3. Fluxul datelor prin cod (fișier cu fișier)

1. `src/auction-expiration.ts` — handler Lambda; creează (o singură dată, cached)
   contextul Nest și apelează `AuctionExpirationService.closeExpiredAuctions()`.
2. `src/modules/auctions/expiration/auction-expiration.service.ts`
   - `closeExpiredAuctions()` — paginare peste GSI, batch-uri de 10;
   - `closeAuctionIfExpired()` — UPDATE condiționat (idempotent!);
   - `enqueueWinnerNotification()` — trimite JSON-ul în SQS; erorile sunt
     logate și înghițite (notificarea nu poate strica închiderea).
3. `src/winner-notification.ts` — handler SQS; iterează `event.Records`;
   orice excepție → invocația eșuează → SQS redeliverează batch-ul.
4. `src/modules/notifications/winner-notification.service.ts`
   - `sendWinnerEmail()` — construiește HTML-ul (cu `escapeHtml` pentru titlu),
     trimite prin SES. **Erorile NU sunt înghițite** — propagarea lor e exact
     mecanismul de retry.

## 4. Idempotența — verificată live (21.10.2026)

**Experiment:** același mesaj trimis de 2 ori manual către consumer
(`aws lambda invoke` × 2, payload identic, auctionId "drill-idempotency").

**Rezultat:** 2 invocații separate (RequestId-uri diferite), 2 emailuri trimise.
Concluzie + starea fiecărei verigi:

| Verigă | Idempotentă? | De ce |
|---|---|---|
| Închiderea licitației (DynamoDB) | ✅ DA | `ConditionExpression: status = ACTIVE` — a doua încercare eșuează condiția |
| Enqueue în SQS | ✅ DA (indirect) | se apelează doar după un close reușit → nu poate porni de 2 ori pentru aceeași licitație |
| Livrarea SQS → consumer | ❌ NU | standard queue = at-least-once; plus redelivery la eșec de batch |
| Trimiterea emailului (SES) | ❌ NU | demonstrat live: 2 mesaje identice = 2 emailuri |

**Cum am face emailul idempotent (dacă ar conta):**
- variantă A: marker în DynamoDB — consumerul face întâi un UpdateItem
  condiționat `SET winnerNotifiedAt = :now` cu `attribute_not_exists(winnerNotifiedAt)`;
  dacă condiția pică, mesajul e duplicat → skip fără email;
- variantă B: coadă FIFO cu `MessageDeduplicationId = auctionId`
  (deduplicare doar pe fereastră de 5 minute — nu rezolvă retry-urile ulterioare).

**Notă de design:** duplicarea e acceptabilă aici (worst case: 2 emailuri în
spam). Idempotența strictă costă complexitate — o adaugi când ai o consecință
reală (ex: plăți), nu "din principiu".

## 5. Cum testezi pas cu pas în Postman

### Pregătire
1. Tokenuri proaspete (expiră la 1h). În Git Bash:
   `bash scripts/create-cognito-test-user.sh` creează/actualizează userul.
   Ai nevoie de DOUĂ conturi Cognito:
   - creator: `testuser@example.com`
   - bidder: `danmunteanu420@gmail.com` (emailul real → aici ajunge notificarea)
2. Deschide `postman/Auctions.postman_collection.json` în Postman.

### Testul
1. **Colecție → Variables → `accessToken`** = tokenul CREATORULUI.
2. Rulează **"Create auction"** — pre-request script-ul pune `endDate` la +5 min.
   Salvează `id`-ul din răspuns.
3. Schimbă **`accessToken`** = tokenul BIDDERULUI (creatorul nu poate licita pe
   propria licitație — regulă de business, primești eroare dacă încerci).
4. Rulează **"Place bid"** cu `{"amount": 42}` → verifici `currentBid: 42`.
5. **Așteaptă** endDate + până la 5 minute (următorul tick EventBridge).
6. **"Verify auto-close"** (GET by id) → `status: "CLOSED"`.
7. Verifică emailul la danmunteanu420@gmail.com — **și folderul SPAM**.
8. Bonus — dovezi în CloudWatch Logs:
   - `...-closeExpiredAuctions`: "Winner notification enqueued for auction ..."
   - `...-sendWinnerNotification`: "Winner notification sent for auction ..."
9. Bonus — SQS Console: DLQ-ul trebuie să aibă 0 mesaje.

### Debugging: lanțul de dovezi îți spune cine e vinovatul
```text
status ≠ CLOSED                    → scheduler/expiration Lambda
CLOSED, fără log "enqueued"        → producer (fără bids? fără queue URL?)
"enqueued", fără log în consumer   → event source mapping / IAM
eroare SES în consumer             → identitate neverificată / FromAddress
mesaje în DLQ                      → eșec repetat ×3 — citește mesajul din DLQ
```

## 6. Comenzi utile (Git Bash — atenție la `MSYS_NO_PATHCONV=1`!)

```bash
# câte mesaje sunt în DLQ (trebuie 0)
MSYS_NO_PATHCONV=1 aws sqs get-queue-attributes --region eu-central-1 \
  --queue-url "https://sqs.eu-central-1.amazonaws.com/<ACCOUNT_ID>/nestjs-aws-serverless-dev-winner-notifications-dlq" \
  --attribute-names ApproximateNumberOfMessages

# logurile consumerului din ultima oră
MSYS_NO_PATHCONV=1 aws logs filter-log-events --region eu-central-1 \
  --log-group-name /aws/lambda/nestjs-aws-serverless-dev-sendWinnerNotification \
  --start-time $(( $(date -u +%s) - 3600 ))000 \
  --query 'events[].message' --output text
```
