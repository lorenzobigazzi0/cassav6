# Print spool asincrono e durabile — Step 6

Rende la coda di stampa **durabile** e **replayabile** su una tabella relazionale
autoritativa con claim atomico, isola le stampanti in errore con un circuit
breaker ed espone lo stato stampa via event outbox (`print.status`). La stampa
non blocca mai la GUI (API già 202) e i job non si perdono a crash.

## Coda relazionale `print_spool` (SQL-primary)

Migrazione `019_print_spool.sql`. Con `PRINT_SPOOL_SQL_PRIMARY=1` ogni stampa
accettata viene inserita nella tabella relazionale (autoritativa per coda/claim);
l'app-state `printSpoolJobs` resta come mirror per i GET esistenti.

Stati (macchina a stati `print-state-machine.js`): `queued → claimed → sent →
confirmed` / `failed_retryable` / `failed_final`.

**Claim atomico** (`PrintSpoolRepository.claimNext`): dentro una transazione
relazionale fa prima il reclaim dei lease scaduti, poi prende il job pronto più
vecchio (`queued`/`failed_retryable` con `next_retry_at <= now`) e lo marca
`claimed` con `claimed_by` + `lease_expires_at`. Essendo la transazione
serializzata, due claim non prendono mai lo stesso job.

**Crash recovery**: ogni job `claimed` è tenuto da un worker vivo tramite un
lease; se il worker muore, il lease scade e `reclaimExpiredLeases` (runtime) o
`reclaimAllClaimed` (all'avvio) riportano il job in coda. All'avvio dell'owner
tutti i `claimed` orfani tornano `queued`.

**Retry/backoff**: `markFailed({ retryable:true, retryDelayMs })` porta a
`failed_retryable` con `next_retry_at` futuro e `attempt_count++`; il job non è
riclaimabile prima del retry time. Non-retryable → `failed_final` (terminale).

## Circuit breaker stampante

`printer-circuit-breaker.js`, gated su `PRINT_CIRCUIT_BREAKER=1`. Per-stampante:
dopo `PRINT_CIRCUIT_BREAKER_THRESHOLD` fallimenti consecutivi il circuito si apre
per `PRINT_CIRCUIT_BREAKER_COOLDOWN_MS`; scaduto → `half_open` (un probe); un
successo lo richiude. Il worker, prima di tentare, chiede `canAttempt(printerId)`:
se il circuito è aperto non martella la stampante offline (il job resta a retry),
così una stampante ko non rallenta la coda.

## `print.status` via event outbox

Ogni transizione emette un evento durabile `print.status` (riuso Step 5):
aggregate `("print", jobId)`, payload `{ jobId, orderId, printerId, status,
attemptCount }`, recuperabile via `GET /api/realtime/replay`.

## Feature flag

```env
PRINT_SPOOL_SQL_PRIMARY=1        # coda relazionale autoritativa + claim atomico
PRINT_CIRCUIT_BREAKER=1          # circuit breaker per stampante
PRINT_SPOOL_CLAIM_LEASE_MS=30000
PRINT_CIRCUIT_BREAKER_THRESHOLD=3
PRINT_CIRCUIT_BREAKER_COOLDOWN_MS=15000
```

Rollback: `PRINT_SPOOL_SQL_PRIMARY=0` → percorso spool legacy (app-state) invariato.

## Metriche

Sezione `printSpool` dello snapshot `/api/monitor/runtime-metrics`: `claimed`,
`confirmed`, `failed`, `reclaimed`, `printerTimeouts`, `queueDepth`,
`queueLagMs`, `circuitOpen`, `orphanFiles`. `printAcceptedMs` (latenza
accettazione API) e `printSpoolClaimMs` via `recordOperation("printSpool", …)`.

## Limiti noti

- `PRINTING_ENABLED=0` in questo ambiente: la stampa fisica non avviene (job
  `disabled` → terminale). L'infrastruttura durabile + claim + reclaim + circuit
  breaker è testata nei test unit; l'e2e copre enqueue durabile, `print.status` e
  reclaim al riavvio.
- Owner-only: coda/claim/worker vivono sull'owner (claim su singola connessione
  relazionale). MySQL resta fonte di verità; `print_spool` relazionale è il log
  durabile della coda di stampa.

## Test

```bash
npm run test:phase6   # repo (claim atomico/retry/reclaim/retention) + circuit breaker + e2e
npm run check:backend
```
