# Fase P3.14 - Async flush gate e layout sotto carico

Data: 2026-07-08
Target: Raspberry `192.168.1.79`

## Obiettivo

Chiudere il gate P3.14 dopo l'adozione del flush asincrono app-state per gli ordini, eliminando:

- retry `ordersAsyncFlush/revisionConflict`;
- 500 intermittenti sulla GET `/api/integration/layout` durante canary concorrenti;
- timeout Redis falsi positivi sotto carico sul Raspberry.

## Modifiche

- `backend/modules/integration/order-async-appstate-flush.js`
  - la lettura `readDb()` avviene dentro il wrapper esclusivo MySQL;
  - i conflitti revisione app-state vengono recuperati inline dentro il lock con reread `forceReload`;
  - il retry/backoff della coda resta come fallback se il conflitto persiste.
- `backend/server.js`
  - il refresh opportunistico della layout GET e' best-effort: un errore di persistenza non trasforma piu' la lettura layout in HTTP 500.
- `scripts/collect-runtime-metrics.mjs`
  - aggiunti `--user-id` e `--device-uuid`, necessari per l'endpoint monitor autenticato.
- `scripts/order-worker-sync-e2e-canary.mjs`
  - se la layout fallisce, il canary salva anche il body della risposta.
- `deploy/raspberry-final/cassav4.env.example`
  - `REDIS_CONNECT_TIMEOUT_MS=1000`;
  - `REDIS_COMMAND_TIMEOUT_MS=1000`.
- `configs/near-realtime-redis.env.example` e `docs/redis-step10.md`
  - allineati al timeout Redis da 1000 ms.

Sul target e' stato aggiornato anche `/etc/cassav4/cassav4.env`, con backup automatico `cassav4.env.before-redis-timeout-*`.

## Verifiche

Test locali:

- `node --check backend/server.js`
- `node --check backend/modules/integration/order-async-appstate-flush.js`
- `node --check scripts/collect-runtime-metrics.mjs`
- `node --check scripts/order-worker-sync-e2e-canary.mjs`
- `node --test backend/tests/order-async-appstate-flush.test.mjs`: 8/8 pass

Test su Raspberry:

- `node --test backend/tests/order-async-appstate-flush.test.mjs`: 8/8 pass
- probe layout: 120 richieste, concorrenza 12, failure 0

## Gate P3.14

Run 1:

- directory: `/var/log/cassav4/p314_layout_best_effort_inline_redis1000_c3_20260708_004909`
- canary: 50/50 ok
- create/sync/cleanup: 50/50 su `api-worker`
- `retryLikeCount`: 0
- `p3GateClean`: true
- counters: vuoti

Run 2:

- directory: `/var/log/cassav4/p314_layout_best_effort_inline_redis1000_c3_b_20260708_005151`
- canary: 50/50 ok
- create/sync/cleanup: 50/50 su `api-worker`
- `retryLikeCount`: 0
- `p3GateClean`: true
- counters: vuoti

## Stato

P3.14 chiusa: due gate consecutivi puliti sul target commerciale, con stampa/fiscale/cassa automatica reale disattivati.
