# Debugging AWS cu dovezi — ghid pentru student

Scopul este să găsești veriga ruptă din lanț, nu să ghicești. Pornește de la un `auctionId`, un `correlationId` și un interval UTC. Schimbă o singură variabilă și repetă măsurătoarea.

> Comenzile de mai jos interoghează un cont AWS real. Nu creează resurse, dar pot genera costuri mici de CloudWatch. Înlocuiește stage-ul și ID-urile; nu presupune că vechiul deploy mai există.

## 1. Pregătire

Numele funcțiilor noi includ sufixul `-api` în numele serviciului:

```bash
# Variabilele evită copy-paste greșit; valori valabile numai în terminalul curent.
export STAGE=dev
export REGION=eu-central-1
export SERVICE=nestjs-aws-serverless-api
export LOG_API="/aws/lambda/${SERVICE}-${STAGE}-api"
export LOG_CLOSE="/aws/lambda/${SERVICE}-${STAGE}-closeExpiredAuctions"
export LOG_NOTIFY="/aws/lambda/${SERVICE}-${STAGE}-sendWinnerNotification"
```

Verifică identitatea și regiunea înainte de loguri. Dacă această comandă eșuează, problema este autentificarea AWS, nu aplicația.

```bash
aws sts get-caller-identity
aws configure get region
```

Listează grupurile ca să confirmi numele reale. `MSYS_NO_PATHCONV=1` oprește Git Bash din a transforma `/aws/...` într-o cale Windows.

```bash
MSYS_NO_PATHCONV=1 aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${SERVICE}-${STAGE}" \
  --region "$REGION" \
  --query 'logGroups[].logGroupName' --output table
```

Retenția aplicației este 7 zile în profilul cost-safe. Logurile pot apărea cu zecile de secunde întârziere; „nu găsesc nimic acum” nu înseamnă automat „nu s-a executat”.

### ERR_REQUIRE_ESM / funcția moare la init

Dacă logul arată `require() of ES Module ... not supported`, bundle-ul este CommonJS, dar NestJS 12 este ESM-only. Verifică în `api.yml`:

```yaml
custom:
  esbuild:
    format: esm
    outputFileExtension: '.mjs'
```

ZIP-ul trebuie să conțină `src/*.mjs`, nu `src/*.js`. `plugins.js` trebuie să apeleze `esbuildPluginTsc({ forceEsm: true })`.

### /health direct răspunde 403, dar CloudFront răspunde 502

Verifică Lambda@Edge `nestjs-aws-serverless-edge-origin-header-prod` în `us-east-1`: logurile și rolul IAM trebuie să poată citi SecureString-ul `.../secrets/edge-shared-secret`. Dacă header-ul lipsește, `EdgeOriginGuard` returnează 403; dacă funcția edge eșuează, CloudFront poate returna 502.

### AWS CLI pe Windows întoarce `\r`

Când un script Bash compară numeric un rezultat `--output text`, `512\r` nu trece de `^[0-9]+$`. Pipează prin `tr -d '\r'` înainte de validare. Același lucru este necesar pentru tokenuri și ID-uri citite din CLI.

### DynamoDB ValidationException la UpdateItem

Dacă logul arată `ValidationException` după un update, verifică `ExpressionAttributeNames`. Fiecare `#nume` din `UpdateExpression` și `ConditionExpression` trebuie declarat; altfel DynamoDB respinge comanda. Testele cu client mock nu prind această eroare — adaugă un test care extrage toate `#placeholder`-urile și verifică maparea.

### SNS PendingConfirmation a dispărut

O subscripție neconfirmată este ștearsă de AWS după 48 de ore, dar CloudFormation continuă să creadă că resursa există (drift). Recreează subscripția și confirmă emailul imediat; nu presupune că `CREATE_COMPLETE` înseamnă confirmare.

## 2. Cum arată dovada

Aplicația scrie JSON:

```json
{"level":"INFO","service":"auctions-api","timestamp":"2026-10-29T12:00:00.000Z","message":"Winner notification enqueued","auctionId":"abc-123","correlationId":"request-456"}
```

Lambda adaugă și:

```text
START RequestId: ...
END RequestId: ...
REPORT RequestId: ... Duration: ... Billed Duration: ... Init Duration: ...
```

- `START` dovedește invocarea;
- `END` dovedește finalizarea la nivel Lambda;
- `REPORT` oferă durată, durată facturată și uneori inițializare cold start;
- `START` fără `END` sugerează timeout/crash, dar verifică și fereastra de căutare;
- un mesaj business de succes dovedește numai operația din mesaj, nu întreg lanțul.

Nu loga sau publica `Authorization`, body-ul SQS, emailul destinatarului sau SecureString-urile.

## 3. Urmărește un request HTTP

Răspunsul API conține `x-request-id` și `x-correlation-id`. Salvează valoarea:

```bash
# Înlocuiește cu ID-ul primit în răspuns, nu cu un ID inventat.
export CORRELATION_ID=request-456
```

Caută exact ID-ul în ultimele 30 de minute. `--start-time` pentru Logs folosește milisecunde epoch.

```bash
export START_MS=$(( $(date +%s) - 1800 ))000
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_API" \
  --start-time "$START_MS" \
  --filter-pattern "\"$CORRELATION_ID\"" \
  --region "$REGION" \
  --query 'events[].{time:timestamp,message:message}' --output table
```

Dacă cererea a ajuns prin CloudFront, un 401 poate veni din JWT authorizer înainte de Lambda. În acest caz absența logului Lambda este un indiciu, nu o eroare de logging. Verifică tokenul, issuer, audience și expirarea fără să afișezi tokenul.

Pentru un 503 `/health`, caută `Dependency health check failed` și câmpul `dependency`. Contractul răspunsului spune care dintre DynamoDB/SQS este `down`.

## 4. Verifică crearea și paginarea

În Postman, creearea trebuie să returneze 201, `id`, `status=ACTIVE` și `imageUrl`, fără `imageKey`. Listele returnează `{ items, nextCursor? }`, nu un array simplu.

Dacă prima pagină nu conține licitația, nu concluziona că lipsește. Continuă cu `nextCursor`, păstrează același filtru și limită. GSI-urile sunt eventual consistent; un item proaspăt creat poate apărea cu întârziere într-un index.

Pentru un item cunoscut, `GetItem` pe cheia primară separă datele de index:

```bash
# Citește direct itemul; nu folosește GSI și nu dovedește că imaginea S3 există.
aws dynamodb get-item \
  --table-name "nestjs-aws-serverless-auctions-${STAGE}" \
  --key "{\"id\":{\"S\":\"$AUCTION_ID\"}}" \
  --region "$REGION"
```

Deschide `imageUrl` imediat: este valabil doar 300 secunde. După CLOSED, absența URL-ului este intenționată. Pentru a distinge URL expirat de obiect lipsă, verifică `HeadObject` numai în stage-ul de test:

```bash
aws s3api head-object \
  --bucket "nestjs-aws-serverless-auction-images-${STAGE}" \
  --key "auctions/${AUCTION_ID}/image.webp" --region "$REGION"
```

## 5. Verifică EventBridge și închiderea

Un schedule sănătos produce aproximativ 12 invocări pe oră, dar o invocare poate fi goală dacă nu există licitații expirate.

```bash
# START arată ritmul schedulerului în ultima oră.
export HOUR_AGO_MS=$(( $(date +%s) - 3600 ))000
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_CLOSE" --start-time "$HOUR_AGO_MS" \
  --filter-pattern 'START' --region "$REGION" \
  --query 'events[].timestamp' --output table
```

Apoi caută licitația concretă:

```bash
# Corelează schedulerul cu auctionId; nu te opri la simpla invocare.
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_CLOSE" --start-time "$HOUR_AGO_MS" \
  --filter-pattern "\"$AUCTION_ID\"" --region "$REGION" \
  --query 'events[].{time:timestamp,message:message}' --output table
```

Interpretare:

- niciun START: verifică regula EventBridge și permisiunea Lambda;
- START + eroare: verifică IAM, GSI, timeout și dependențele;
- invocare fără item: poate fi prea devreme sau GSI nu a propagat încă itemul;
- CLOSED fără enqueue: verifică câștigătorul și `notificationStatus=PENDING`;
- PENDING persistent: producerul nu a putut publica; verifică queue URL și `sqs:SendMessage`.

EventBridge are propriul DLQ pentru imposibilitatea livrării targetului. Acest DLQ nu dovedește o eroare din interiorul handler-ului.

## 6. Verifică consumerul SQS și SES

Caută același ID în logul notificării:

```bash
# Dovada consumerului trebuie să fie separată de dovada producerului.
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_NOTIFY" --start-time "$HOUR_AGO_MS" \
  --filter-pattern "\"$AUCTION_ID\"" --region "$REGION" \
  --query 'events[].{time:timestamp,message:message}' --output table
```

Evenimente utile: duplicate, claim eșuat, circuit deschis, fallback DLQ și succes SES. Un `batchItemFailures` gol confirmă recordurile, dar nu garantează livrarea emailului în inbox.

Obține URL-ul DLQ din SSM și apoi metricile cozii. Comanda SSM citește un identificator String, nu un secret.

```bash
export DLQ_URL="$(aws ssm get-parameter \
  --name "/nestjs-aws-serverless/${STAGE}/winner-notifications/dlq-url" \
  --query Parameter.Value --output text --region "$REGION")"

# Depth > 0 necesită investigație; nu folosi purge.
aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateAgeOfOldestMessage \
  --region "$REGION"
```

Pentru DLQ EventBridge folosește ARN-ul SSM și construiește URL-ul numai după convenția contului, sau citește coada din consolă. Nu amesteca cele două DLQ-uri.

Dacă consumerul raportează succes, dar emailul lipsește, verifică SES identity, sandbox, bounce/complaint și spam. „SES a acceptat” și „utilizatorul a citit” sunt evenimente diferite.

## 7. Idempotență: cum testezi fără concluzii false

Un duplicat după `COMPLETED` trebuie ignorat. Un duplicat în timpul unui lease este `busy`. Un claim expirat poate fi reluat.

Nu testa duplicatele cu același `claimToken` prin apel direct artificial al serviciului: tokenul este generat per record în handler. Trimite același payload SQS într-un stage izolat și compară `auctionId`, RequestId și numărul efectiv de emailuri.

Cazul „SES succes + crash înainte de COMPLETED” permite un retry după lease și poate produce un al doilea email. Acesta este un compromis documentat, nu un bug pe care îl poți rezolva printr-un simplu flag local.

## 8. Alarme și metrici

```bash
# Starea alarmei arată pragul curent, nu cauza; inspectează logurile apoi.
aws cloudwatch describe-alarms \
  --alarm-names "${SERVICE}-${STAGE}-winner-dlq-messages" \
  --region "$REGION" --query 'MetricAlarms[].{State:StateValue,Reason:StateReason}'
```

Opt alarme acoperă DLQ depth/age și Errors/Throttles pentru ambele funcții async. `OK` pe Lambda Errors nu exclude erorile tratate și trimise manual în DLQ. `OK` pe DLQ nu dovedește că SES a livrat în inbox.

Metricile business sunt în namespace `Auctions`; logurile EMF apar în CloudWatch Logs și sunt transformate în metrici. Nu confunda JSON-ul aplicației cu formatul EMF.

## 9. Tail live și Log Insights

Pentru un test controlat, urmărește o funcție în alt terminal. Oprești cu Ctrl+C.

```bash
MSYS_NO_PATHCONV=1 aws logs tail "$LOG_NOTIFY" --follow --region "$REGION"
```

În Log Insights poți căuta JSON după ID:

```text
fields @timestamp, @message
| filter @message like /abc-123/
| sort @timestamp desc
| limit 50
```

Fereastra de timp rămâne obligatorie. Un query larg costă mai mult și amestecă invocări diferite.

## 10. Tabel de diagnostic

| Observație | Următoarea frontieră de verificat |
|---|---|
| 401 fără log Lambda | Cognito JWT authorizer |
| CORS în browser | origine exactă, preflight, credentials; nu „repara” prin `*` |
| 503 health | check-ul `down`, IAM și timeout dependență |
| POST 201, imagine indisponibilă | URL 300s, HeadObject, chei WebP |
| PATCH 403 | owner `sub` și condiția atomică |
| Licitație ACTIVE după deadline | schedule + GSI + următorul tick |
| CLOSED + PENDING | producer SQS/IAM |
| enqueue fără consumer | event source mapping și rol consumer |
| duplicate ignorat | tombstone COMPLETED, comportament corect |
| circuit deschis | erori SES tranzitorii consecutive |
| DLQ > 0 | payload, SES, claim și cauza originală; nu purge |
| succes SES, inbox gol | sandbox, bounce, spam, adresă |

Metoda rămâne mereu: observă → formulează o ipoteză → verifică o frontieră → schimbă un singur lucru → rulează din nou → adaugă test de regresie.
