# FASE G4 - Stampa manuale asincrona C1/C3

Data: 2026-07-01

## Obiettivo

Allineare la route manuale `POST /api/integration/print` al fast worker della stampa automatica:
la chiamata deve restituire subito `202` con `jobId`, mentre claim, invio TCP, retry e complete restano al worker.

## Implementazione

- `POST /api/integration/print` risponde `202 Accepted`.
- La risposta ora esplicita:
  - `accepted: true`
  - `async: true`
  - `jobId`
  - `status`
  - `queued`
- Quando `PRINT_SPOOL_FAST_WORKER=1` e il dominio `printSpoolJobs` e' split MySQL, la route esce dalla coda globale.
- Aggiunto `enqueuePrintSpoolJobFast`, che crea il job e sincronizza solo la singola entry `printSpoolJobs`.
- Il worker continua a fare claim/complete con il fast path gia' esistente.
- Se sul fast path la stampante non e' configurata/usabile, viene creato un job tracciabile `failed_configuration`
  invece di legare la richiesta al ciclo di stampa.
- Il fallback legacy senza fast worker resta serializzato per proteggere il JSON app-state.

## Test aggiornati

- `backend/tests/print-spool-fast-worker.mysql.test.mjs`
  - ora attende `202`;
  - verifica `accepted`, `async`, `queued`, `status`;
  - verifica che la stampa manuale non entri nella coda globale (`print_spool_*` o `/api/integration/print`).
- `backend/tests/security.test.mjs`
  - ristampa manuale aggiornata a `202`.
- `backend/tests/continuity.e2e.test.mjs`
  - helper e preconti manuali aggiornati a `202`.
- `backend/tests/listino-time-pricing.e2e.test.mjs`
  - preconto manuale aggiornato a `202`.
- `backend-release-gate.mjs`
  - aggiunto il test fast worker stampa manuale. Se MySQL locale non e' disponibile, il test si salta; se e'
    disponibile, valida la stampa TCP simulata senza stampanti reali.

## Verifiche

- `node --check backend/server.js`
- `node --test backend/tests/print-spool-fast-worker.mysql.test.mjs`
- `node --test backend/tests/print-spool-retention.test.mjs backend/tests/release-package-guardrails.test.mjs`
- `node --test --test-name-pattern="spostamento tavolo" backend/tests/security.test.mjs`
- `node --test --test-name-pattern="listino" backend/tests/listino-time-pricing.e2e.test.mjs`
- `node scripts/backend-release-gate.mjs`

Esito: OK.

## Note operative

Il comportamento atteso lato client e' trattare `202` come job accettato, non come stampa completata. Lo stato reale
della stampa resta nello spool (`queued`, `processing`, `printed`, `failed`, `failed_configuration`, ecc.).
