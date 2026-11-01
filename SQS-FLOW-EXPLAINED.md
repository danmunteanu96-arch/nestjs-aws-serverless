# SQS, idempotență și DLQ — ghid pentru student

## 1. De ce există coada

Închiderea licitației și trimiterea emailului au profile diferite de disponibilitate. DynamoDB poate confirma închiderea chiar când SES este lent sau indisponibil. SQS păstrează munca și decuplează cele două operații.

SQS Standard oferă livrare **cel puțin o dată**, nu exact o dată și nu ordine strictă. Codul presupune duplicate și retry-uri.

## 2. Fluxul actual, pas cu pas

```text
EventBridge rate(5 minutes)
  │
  ▼
closeExpiredAuctions
  │ Query status-endDate-v2-index: ACTIVE + endDate <= now
  │ UpdateItem condiționat:
  │   status = CLOSED
  │   expiresAt = +90 zile
  │   notificationStatus = PENDING, dacă există câștigător
  │   REMOVE imageKey
  ├──────────────► S3 DeleteObject image.webp + thumbnail.webp
  │
  │ SendMessage { auctionId, recipient, title, winningBid }
  │ succes SQS → REMOVE notificationStatus
  │ eșec SQS   → PENDING rămâne pentru următorul schedule
  ▼
WinnerNotificationsQueue
  │ retention 4 zile, visibility timeout 360 secunde
  │ maxReceiveCount 3, batchSize 10, batching window 5 secunde
  ▼
sendWinnerNotification
  │ Zod parse pentru fiecare record
  │ claim(auctionId, claimToken) în tabelul de idempotență
  ├─ duplicate → acknowledge, fără email
  ├─ busy      → acknowledge; alt worker deține lease-ul
  └─ claimed   → SES cu timeout/retry/circuit breaker
                  ├─ succes → COMPLETED → acknowledge
                  └─ eșec   → SendMessage manual în DLQ
                              ├─ DLQ acceptă → release lease → acknowledge sursa
                              └─ DLQ eșuează → batchItemFailures pentru record
```

`ReportBatchItemFailures` face ca numai recordurile returnate în `batchItemFailures` să fie reîncercate de SQS. Un mesaj defect nu obligă la reprocesarea întregului batch.

## 3. Unde sunt implementate regulile

| Fișier | Responsabilitate |
|---|---|
| `src/modules/auctions/expiration/auction-expiration.service.ts` | close atomic, PENDING, retry producer |
| `resources/WinnerNotificationsQueueResource.yml` | queue, DLQ, retention, redrive |
| `api.yml` | event source mapping, batch 10, partial failures |
| `src/modules/notifications/winner-notification.types.ts` | schemă Zod strictă |
| `src/modules/notifications/winner-notification.handler.ts` | rezultat per record și fallback DLQ |
| `src/modules/notifications/notification-idempotency.service.ts` | claim/complete/release atomic |
| `src/modules/notifications/ses-resilience.service.ts` | timeout, backoff, jitter, circuit |
| `src/modules/notifications/winner-notification.service.ts` | email HTML + text, escaping |
| `resources/AlarmsResource.yml` | alarme DLQ și Lambda |

Rolurile sunt în `iam/ExpirationRole.yml` și `iam/WinnerNotificationRole.yml`, nu într-un fișier IAM comun.

## 4. Idempotența corectă

Cheia de idempotență este `auctionId`. Fiecare procesare primește și un `claimToken` UUID.

### `claim`

`PutItem` reușește dacă:

- nu există încă item pentru licitație; sau
- itemul este `IN_PROGRESS` și lease-ul de 60 secunde a expirat.

Un item `COMPLETED` nu poate fi revendicat. La conflict, consumerul citește consistent statusul și distinge `duplicate` de `busy`.

### `complete`

După SES, update-ul devine `COMPLETED` numai dacă statusul și tokenul aparțin aceluiași worker. Tokenul este eliminat, iar tombstone-ul rămâne 30 de zile.

### `release`

După acceptarea fallback-ului în DLQ, lease-ul devine expirat numai pentru același token. O redrive ulterioară poate încerca din nou. Un worker întârziat nu poate completa sau elibera claim-ul altui worker.

### Limita importantă

Idempotența nu poate garanta exactly-once pentru efectul extern SES. Dacă SES trimite emailul, dar Lambda cade înainte de `complete`, lease-ul expiră și un retry poate trimite din nou. Soluția actuală elimină duplicatele după un `COMPLETED` durabil și face crash-ul recuperabil, dar nu pretinde imposibilul: exactly-once peste două sisteme fără tranzacție comună.

## 5. Retry în două locuri diferite

**Retry producer:** dacă închiderea reușește, dar SQS `SendMessage` eșuează, `notificationStatus=PENDING` rămâne. GSI sparse `notificationStatus-createdAt-index` conține numai aceste iteme. Următoarea invocare scheduled reia publicarea. După acceptarea SQS, atributul este șters.

**Retry consumer:** erorile unui record pot produce retry SQS. În plus, serviciul SES are propriile încercări scurte. Aceste niveluri nu trebuie confundate:

- retry-ul SDK/aplicației acoperă o eroare tranzitorie imediată;
- visibility timeout + SQS acoperă o invocare eșuată;
- DLQ păstrează cazul care necesită investigație;
- PENDING acoperă eșecul înainte ca mesajul să ajungă măcar în coadă.

## 6. SES circuit breaker și fallback

Implicit:

- maximum 3 încercări pentru erori tranzitorii;
- timeout 5 secunde per încercare;
- backoff 100 ms, 200 ms etc., plafonat la 2 secunde, cu jitter;
- circuit deschis după 3 eșecuri tranzitorii consecutive;
- cooldown 30 secunde.

Erorile permanente, precum configurarea sau respingerea destinatarului, nu sunt reîncercate orb. Circuitul este per execution environment cald, nu global pentru toate instanțele Lambda.

Dacă trimiterea nu reușește, handler-ul încearcă să scrie body-ul original în `WinnerNotificationsDLQ`. Sursa este confirmată numai după acceptarea DLQ. Dacă nici DLQ nu funcționează, recordul apare în `batchItemFailures` și rămâne sub controlul retry/redrive SQS.

Payload-ul invalid este trimis direct în DLQ, fără claim sau SES. Logurile păstrează numai informații sigure; nu afișa destinatarul sau body-ul.

## 7. Alarme și investigație

Există alarme pentru ambele DLQ-uri și pentru erorile/throttling-ul celor două funcții async. SNS trimite email numai după ce confirmi abonarea.

Nu șterge DLQ-ul ca să „repari” alarma. Mai întâi răspunde:

1. Payload-ul respectă schema?
2. Expeditorul SES este verificat și are IAM corect?
3. SES este în sandbox? Destinatarul de test este permis?
4. Există throttling, timeout sau erori 5xx?
5. Claim-ul este `IN_PROGRESS` cu lease expirat sau `COMPLETED`?
6. Este DLQ pentru consumer sau pentru livrarea EventBridge?

Redrive este o operație deliberată după corectarea cauzei. Purge este destructiv și nu face parte din procedura normală.

## 8. Exercițiu de laborator într-un stage izolat

Acest laborator apelează AWS și poate genera costuri. Nu îl rula în producție.

1. Creează două conturi Cognito de test și o licitație cu alt utilizator decât câștigătorul.
2. Plasează bid-ul și așteaptă `endDate` plus următorul tick.
3. Verifică CLOSED, absența `imageUrl` și logul `Winner notification enqueued`.
4. În logurile consumerului caută același `auctionId` și evenimentul de succes.
5. Trimite manual același payload valid într-un stage de test. Dacă claim-ul este COMPLETED, al doilea record trebuie ignorat fără al doilea email.
6. Folosește un payload invalid numai în coada de test și observă DLQ + alarma.
7. Corectează cauza, apoi redrive după procedura contului. Nu folosi adrese reale pentru teste; SES simulator este preferabil.

Dovezile se caută după `auctionId` și `correlationId`, nu după presupuneri despre timp.

## 9. Verificare operațională rapidă

```bash
# Ambele DLQ-uri trebuie să fie 0 vizibile și 0 in-flight.
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-central-1.amazonaws.com/<account>/nestjs-aws-serverless-prod-winner-notifications-dlq \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Urmărește decizia de idempotență și succesul SES.
aws logs filter-log-events \
  --log-group-name /aws/lambda/nestjs-aws-serverless-api-prod-sendWinnerNotification \
  --filter-pattern '"Winner notification"'
```

Alarma SNS este utilă numai după ce subscripția de email este confirmată. O subscripție `PendingConfirmation` expiră după 48 de ore; recreeaz-o și confirmă imediat. Harta completă a serviciilor, costurile și teardown-ul sunt în `docs/aws-learning-guide.md`.
