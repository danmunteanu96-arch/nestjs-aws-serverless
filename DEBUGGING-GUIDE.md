# Debugging Guide — cum cauți în loguri ce s-a întâmplat în sistem

> Fișier de învățare. NU se commit-uiește.
> Scop: răspunzi la 3 întrebări DIN LOGURI, nu din presupuneri:
> 1. Când a fost creat ultimul auction?
> 2. A rulat `closeExpiredAuctions` și a închis ceva?
> 3. A rulat `sendWinnerNotification` și a trimis email?

---

## 0. Fundamentele înainte de comenzi (2 minute, esențiale)

### 0.1 Unde "locuiesc" logurile

Fiecare funcție Lambda scrie automat în **CloudWatch Logs**, într-un **log group**
cu numele `/aws/lambda/<numele-functiei>`:

```
/aws/lambda/nestjs-aws-serverless-dev-api                      ← toate requesturile HTTP
/aws/lambda/nestjs-aws-serverless-dev-closeExpiredAuctions     ← cronul de 5 minute
/aws/lambda/nestjs-aws-serverless-dev-sendWinnerNotification   ← consumatorul SQS
```

În interiorul unui log group există **log streams** — câte unul per instanță de
container Lambda. Nu trebuie să alegi stream-ul manual: comenzile de mai jos
caută în TOATE stream-urile grupului deodată.

**Retenție:** 14 zile (`logRetentionInDays: 14` din serverless.yml). Loguri mai
vechi de 14 zile pur și simplu nu mai există.

### 0.2 Regula de aur a debuggingului serverless: LATENȚA DE INGESTIE

Logurile NU apar instant în CloudWatch. Durează **30–60 de secunde** din momentul
execuției până le poți căuta. Dacă cauți ceva ce s-a întâmplat ACUM 10 secunde
și nu găsești nimic — nu înseamnă că nu s-a întâmplat. Așteaptă un minut și
reia căutarea. (Ne-am ars cu asta în sesiunea trecută la drill-ul de idempotență.)

### 0.3 Prefixul obligatoriu în Git Bash

Git Bash "traduce" automat căile care încep cu `/` în căi Windows
(`/aws/lambda/...` → `C:/Program Files/Git/aws/lambda/...`), ceea ce distruge
numele log group-urilor. De aceea **orice comandă AWS CLI cu parametri care încep
cu `/` se prefixează cu:**

```bash
MSYS_NO_PATHCONV=1
```

### 0.4 Anatomia unei linii de log Lambda

```
2026-10-19T16:33:31.123Z  d41de773-...  INFO  Winner notification sent ...
│                          │              │     └─ mesajul propriu-zis (al tău, din cod)
│                          │              └─ nivelul (INFO/ERROR/WARN)
│                          └─ RequestId: ID unic al invocării — cel mai util lucru din log
└─ timestamp UTC al liniei
```

Pe lângă liniile tale, Lambda adaugă automat:

```
START RequestId: d41de773-... Version: $LATEST      ← invocarea a început
END   RequestId: d41de773-...                        ← invocarea s-a terminat
REPORT RequestId: ... Duration: 231 ms  Billed Duration: 232 ms  Memory Used: 87 MB
```

`START`/`END`/`REPORT` îți spun că o invocare A AVUT LOC chiar dacă codul nu a
logat nimic. `REPORT` îți spune și cât a durat/costat. **Debugging 101: dacă vezi
START dar nu vezi END, funcția a fost omorâtă (timeout sau crash).**

---

## 1. Pregătirea (o singură dată per terminal)

### Pasul 1.1 — verifici că AWS CLI e configurat și în ce regiune ești

**De ce:** toate comenzile de mai jos depend de credențiale și regiune corecte.
**Ce face:** îți arată identitatea contului cu care ești autentificat.

```bash
aws sts get-caller-identity
```

Aștepți să vezi `Account` și `Arn`. Dacă primești eroare de credențiale, logurile
sunt ultima ta problemă — rezolvi întâi autentificarea.

### Pasul 1.2 — confirmi că cele 3 log group-uri există

**De ce:** dacă numele log group-ului e greșit, căutările întorc 0 rezultate și
crezi că "nu a rulat nimic" — fals negativ clasic. Verifici numele EXACTE întâi.
**Ce face:** listează toate log group-urile care încep cu prefixul aplicației.

```bash
MSYS_NO_PATHCONV=1 aws logs describe-log-groups \
  --log-group-name-prefix /aws/lambda/nestjs-aws-serverless \
  --region eu-central-1 \
  --query 'logGroups[].logGroupName' \
  --output table
```

**Teaching point — `--query`:** folosește JMESPath ca să decupezi doar câmpul care
te interesează din JSON-ul mare pe care îl întoarce AWS. `logGroups[].logGroupName`
= "din fiecare element al listei logGroups, ia doar numele". Vei folosi asta peste tot.

### Pasul 1.3 — definești 3 variabile ca să nu copiezi numele lungi

**De ce:** comenzile devin citibile și nu greșești la copy-paste.
**Ce face:** salvează numele în variabile de shell (valabile doar în sesiunea curentă).

```bash
LOG_API="/aws/lambda/nestjs-aws-serverless-dev-api"
LOG_CLOSE="/aws/lambda/nestjs-aws-serverless-dev-closeExpiredAuctions"
LOG_NOTIFY="/aws/lambda/nestjs-aws-serverless-dev-sendWinnerNotification"
```

Dacă închizi terminalul, le redefinești. Verifici cu `echo $LOG_API`.

---

## 2. Întrebarea 1: Când a fost creat ultimul auction?

Aici înveți cea mai importantă tehnică: **corelarea**. Ai două surse de adevăr —
datele de business (DynamoDB/API) și logurile (CloudWatch). Debuggingul înseamnă
să le pui față în față.

### Pasul 2.1 — afli din DATE care e ultimul auction

**De ce:** "ultimul auction" nu îl ghicești din loguri — îl afli din baza de date,
apoi verifici în loguri că crearea lui a lăsat urme.
**Ce face:** cere API-ului lista licitațiilor și extrage id-ul + data creării.

```bash
curl -s https://peyyy5541k.execute-api.eu-central-1.amazonaws.com/auctions | \
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);a.sort((x,y)=>x.createdAt<y.createdAt?1:-1);console.log(JSON.stringify(a[0],null,2))})"
```

**Teaching point:** `curl` cere datele, iar fragmentul de Node le sortează
descrescător după `createdAt` și ți-l arată pe cel mai recent. Notează
`createdAt` — de exemplu `2026-10-19T16:41:55.377Z`. ASTA e întâmplarea pe care
o cauți în loguri.

### Pasul 2.2 — convertești timestamp-ul în milisecunde pentru filtrul AWS

**De ce:** `filter-log-events` vrea `--start-time` în **milisecunde epoch**,
nu în format ISO. Cauți într-o fereastră de ±2 minute în jurul creării.
**Ce face:** calculează limitele ferestrei de căutare.

```bash
# Pune aici createdAt-ul de la pasul 2.1:
CREATED="2026-10-19T16:41:55.377Z"

START_MS=$(( $(date -d "$CREATED" +%s%3N) - 120000 ))   # 2 minute ÎNAINTE
END_MS=$(( $(date -d "$CREATED" +%s%3N) + 120000 ))     # 2 minute DUPĂ
echo "caut intre $START_MS si $END_MS"
```

**Teaching point:** `%s%3N` = secunde epoch + milisecunde. Scădem/adunăm 120000 ms
= 2 minute. Fereastra mică e deliberată: în debugging, cu cât fereastra e mai
strânsă, cu atât zgomotul e mai mic.

### Pasul 2.3 — cauți în logurile funcției `api` urma requestului POST

**De ce:** crearea unui auction = un `POST /auctions` care a trecut prin funcția
`api`. Dacă crearea a avut loc, funcția a fost invocată și a logat ceva.
**Ce face:** scoate toate evenimentele de log din fereastra de 4 minute.

```bash
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_API" \
  --start-time "$START_MS" \
  --end-time "$END_MS" \
  --region eu-central-1 \
  --query 'events[].{t:timestamp,msg:message}' \
  --output table
```

Ce cauți în output:
- o linie cu `POST /auctions` (interceptorul de logging) — confirmă requestul;
- `START`/`END`/`REPORT` cu același `RequestId` — confirmă că invocarea a mers până la capăt;
- absența liniilor `ERROR` — confirmă că nu a fost un 500 mascat.

### Pasul 2.4 (alternativă rapidă) — caută după pattern, fără fereastră de timp

**De ce:** uneori nu știm CÂND s-a întâmplat — atunci cauți după CE s-a întâmplat.
**Ce face:** `--filter-pattern` lasă să treacă doar liniile care conțin textul dat.

```bash
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_API" \
  --filter-pattern '"POST /auctions"' \
  --region eu-central-1 \
  --query 'events[].{t:timestamp,msg:message}' \
  --output table | tail -20
```

**Teaching point — diferența esențială:**
- `--start-time/--end-time` = "arată-mi TOT din intervalul ăsta" (cauți cronologic);
- `--filter-pattern` = "arată-mi doar liniile care arată așa" (cauți semantic).
Debuggingul real combină ambele: pattern-ul îți dă CÂND, fereastra îți dă CONTEXTUL
(ce s-a mai întâmplat în jurul acelui moment).

⚠️ Ghilimelele din pattern contează: `'"POST /auctions"'` = caută fraza exactă
`POST /auctions`. Fără ghilimele duble, fiecare cuvânt e căutat separat.

---

## 3. Întrebarea 2: A rulat `closeExpiredAuctions`? A închis ceva?

Cronul rulează la fiecare 5 minute, deci aici NU întrebi "a rulat o dată?" ci
"rulează CONSTANT, și a făcut treabă ultima oară?".

### Pasul 3.1 — verifici că funcția e invocată la fiecare ~5 minute

**De ce:** primul semn de viață al unui cron e ritmul lui. Dacă vezi invocări la
16:00, 16:05, 16:10... cronul e sănătos. Dacă ultimul START e de acum 3 ore —
EventBridge nu mai declanșează (sau funcția a fost dezactivată).
**Ce face:** arată doar liniile START din ultima oră — câte una per invocare.

```bash
NOW_MS=$(date +%s%3N)
HOUR_AGO_MS=$(( NOW_MS - 3600000 ))

MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_CLOSE" \
  --start-time "$HOUR_AGO_MS" \
  --filter-pattern 'START' \
  --region eu-central-1 \
  --query 'events[].timestamp' \
  --output table
```

Aștepți ~12 linii (60 min / 5 min). Numără-le. **Asta e "a avut loc?" la nivel macro.**

### Pasul 3.2 — vezi CE a făcut ultima invocare

**De ce:** a fi invocat ≠ a fi făcut treabă. Vrei mesajele de business din cod
(de genul "found N expired auctions" / "closed auction X").
**Ce face:** ia ultimele ~30 de evenimente din log, indiferent de tip.

```bash
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_CLOSE" \
  --start-time "$HOUR_AGO_MS" \
  --region eu-central-1 \
  --query 'events[].{t:timestamp,msg:message}' \
  --output table | tail -40
```

Cum citești:
- invocare "goală" (doar START/END/REPORT, fără mesaje de business) = a rulat,
  nu a găsit nimic expirat → **comportament normal**, nu bug;
- mesaje despre auction închis + eventual "enqueued notification" = a făcut treabă;
- `ERROR` sau `Task timed out after 60` = ai un bug real de investigat.

### Pasul 3.3 — corelezi cu un auction concret pe care îl știi

**De ce:** răspunsul definitiv la "a avut loc ÎN CAZUL MEU?" e să găsești id-ul
licitației tale în loguri.
**Ce face:** caută id-ul (sau titlul) licitației în toată istoria recentă a funcției.

```bash
# Pune id-ul licitației tale aici (din lista GET /auctions):
AUCTION_ID="a76ef835-176f-4777-8d04-4d27dce03f40"

MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_CLOSE" \
  --filter-pattern "\"$AUCTION_ID\"" \
  --region eu-central-1 \
  --query 'events[].{t:timestamp,msg:message}' \
  --output table
```

Dacă licitația ta a fost închisă de cron, vei vedea aici linia exactă cu
timestamp-ul închiderii. **Asta e dovada, nu părerea.**

---

## 4. Întrebarea 3: A rulat `sendWinnerNotification`?

Funcția asta NU are program fix — rulează doar când există mesaje în coadă.
Deci întrebarea corectă e: "pentru auction-ul X, a existat o invocare care a
trimis emailul?".

### Pasul 4.1 — cauzi invocările recente

**De ce:** aceeași logică de semn de viață, dar aici invocările sunt rare —
fiecare START e interesant.
**Ce face:** listează invocările din ultimele 24h.

```bash
DAY_AGO_MS=$(( $(date +%s%3N) - 86400000 ))

MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_NOTIFY" \
  --start-time "$DAY_AGO_MS" \
  --filter-pattern 'START' \
  --region eu-central-1 \
  --query 'events[].timestamp' \
  --output table
```

Fiecare timestamp = o invocare = cel puțin un mesaj consumat din coadă.

### Pasul 4.2 — cauți dovada pentru auction-ul TĂU

**De ce:** mesajul din coadă conține `auctionId` — dacă funcția loghează
ce procesează (și o face), id-ul licitației TREBUIE să apară aici.
**Ce face:** același search după id, dar în log group-ul consumatorului.

```bash
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$LOG_NOTIFY" \
  --filter-pattern "\"$AUCTION_ID\"" \
  --region eu-central-1 \
  --query 'events[].{t:timestamp,msg:message}' \
  --output table
```

Ce vrei să vezi: o linie de tip "sending/sent winner notification" cu id-ul tău,
urmată de `END` fără `ERROR`.

### Pasul 4.3 — verifici că NU a eșuat de 3 ori (DLQ-ul)

**De ce:** dacă funcția a rulat dar a CRĂPAT de fiecare dată, mesajul e acum în
Dead Letter Queue, nu în inbox. Debuggingul nu se oprește la "funcția a rulat" —
se oprește la "rezultatul final e corect".
**Ce face:** numără mesajele din DLQ.

```bash
MSYS_NO_PATHCONV=1 aws sqs get-queue-attributes \
  --queue-url "https://sqs.eu-central-1.amazonaws.com/$(aws sts get-caller-identity --query Account --output text)/nestjs-aws-serverless-dev-winner-notifications-dlq" \
  --attribute-names ApproximateNumberOfMessages \
  --region eu-central-1
```

- `0` mesaje = niciun eșec permanent. ✅
- `> 0` mesaje = ai poison messages. Le citești cu `aws sqs receive-message --queue-url <URL-DLQ>`
  (NU le șterge până nu ai înțeles de ce au eșuat).

### Pasul 4.4 — lanțul complet de dovezi (asta e debuggingul!)

Pune cap la cap timestamp-urile găsite:

```
createdAt (DynamoDB)        →  16:41:55   auction creat      [pas 2]
endDate (DynamoDB)          →  16:46:53   ar fi trebuit să expire
START în LOG_CLOSE          →  16:50:00   cronul a rulat după expirare   [pas 3]
linia cu AUCTION_ID         →  16:50:01   a închis TOCMAI licitația ta
START în LOG_NOTIFY         →  16:50:02   consumatorul a primit mesajul  [pas 4]
linia "sent" cu AUCTION_ID  →  16:50:03   email trimis
DLQ = 0                     →             nimic pierdut pe drum
```

Fiecare verigă are dovada ei. Dacă o verigă LIPSEȘTE, acolo e bug-ul:
- auction creat dar cron nu loghează id-ul → problema e în query/condiția de închidere;
- cron a închis dar LOG_NOTIFY e gol → problema e la enqueue sau event source mapping;
- notify a rulat cu ERROR → problema e în SES (identitate neverificată, From greșit);
- totul OK în loguri dar nu ai email → problema e ÎN AFARA AWS (spam folder, adresa greșită).

**Asta e esența debuggingului distribuit: nu cauți "bug-ul", cauți VERIGA RUPTĂ
din lanț. Sistemul e un lanț de dovezi; tu doar verifici fiecare verigă la rând.**

---

## 5. Comenzi bonus (când vrei să "stai de veghe" pe sistem)

### 5.1 Tail live pe o funcție

**De ce:** în loc să interoghezi la câteva minute, vezi logurile cum apar.
**Ce face:** `aws logs tail --follow` = echivalentul `tail -f` pentru CloudWatch.

```bash
MSYS_NO_PATHCONV=1 aws logs tail "$LOG_CLOSE" --follow --region eu-central-1
```

Oprești cu `Ctrl+C`. Perfect când testezi live: creezi auctionul în Postman într-un
terminal, urmărești logurile în altul.

### 5.2 Doar erorile din ultimele 24h, pe toate funcțiile

**De ce:** primul lucru pe care îl faci când "ceva nu merge" e să vezi dacă există
erori UNDEVA, oriunde.

```bash
for LG in "$LOG_API" "$LOG_CLOSE" "$LOG_NOTIFY"; do
  echo "=== $LG ==="
  MSYS_NO_PATHCONV=1 aws logs filter-log-events \
    --log-group-name "$LG" \
    --start-time "$DAY_AGO_MS" \
    --filter-pattern 'ERROR' \
    --region eu-central-1 \
    --query 'events[].message' \
    --output text
done
```

**Teaching point:** bucla `for` aplică aceeași interogare pe toate cele 3 grupuri.
Output gol peste tot = niciun Lambda nu a raportat erori → problema e în altă parte
(configurare, permisiuni, date, sau... folderul Spam).

### 5.3 Consola web (când CLI-ul e prea lent pentru explorare)

Uneori vrei doar să "răsfoiești". Consola e mai bună la asta:
https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#logsV2:log-groups

Cauți grupul, intri, iar în **Log Insights** poți rula query-uri ca:

```
fields @timestamp, @message
| filter @message like /a76ef835/
| sort @timestamp desc
| limit 20
```

---

## 6. Tabelul de buzunar — ce comandă pentru ce întrebare

| Întrebarea | Unealta |
|---|---|
| "Există log group-ul?" | `describe-log-groups --log-group-name-prefix` |
| "Ce s-a întâmplat la ora X?" | `filter-log-events --start-time/--end-time` |
| "Unde apare textul Y?" | `filter-log-events --filter-pattern` |
| "Rulează cronul?" | `filter-pattern 'START'` + numeri ritmul |
| "A procesat exact ENTITATEA mea?" | `filter-pattern '"<id>"'` |
| "A pierdut ceva pe drum?" | `sqs get-queue-attributes` pe DLQ |
| "Vreau să văd LIVE" | `aws logs tail --follow` |
| "Eroare oriunde?" | `filter-pattern 'ERROR'` pe toate grupurile |

## 7. Capcanele pe care le-ai întâlnit deja (sau le vei întâlni)

1. **Latența de ingestie 30–60s** — "nu găsesc" ≠ "nu s-a întâmplat". Așteaptă și reia.
2. **Git Bash manglează căile** — mereu `MSYS_NO_PATHCONV=1` în fața comenzilor cu `/`.
3. **Timpii sunt UTC** — logurile sunt pe UTC; ora ta locală poate fi +2/+3. Când
   "nu găsesc nimic la ora X", verifică întâi fusul orar.
4. **Timpii sunt milisecunde, nu secunde** — `--start-time 1697...` fără `000` la
   final caută în 1970.
5. **Logurile mor la 14 zile** — nu poți debuga un incident de acum o lună. De aceea
   deciziile importante se documentează CÂND se întâmplă.
6. **START fără END = funcție omorâtă** (timeout/crash), nu "a uitat să logheze".
