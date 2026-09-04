# Fase P3.68 - Order Readback Lookup Puntuale

Data: 2026-07-09

## Obiettivo

Ridurre il collo `readback` emerso dopo P3.67: il canary leggeva la comanda con
`GET /api/integration/orders?orderId=...&includeDone=1&fresh=...`, ma il backend
trattava `includeDone=1` come storico completo e poteva fare `listOrders()`.

## Implementazione

- `backend/modules/integration/scoped-orders-read.js`
  - se la richiesta contiene `orderId`/`id`, `includeDone=1` non abilita piu'
    la lettura storica completa dal relazionale;
  - con write-primary relazionale attivo, il readback usa `getOrderById`;
  - se il lookup puntuale non trova la comanda, resta il fallback al percorso
    scoped/app-state precedente.
- `backend/server.js`
  - `_` non bypassa piu' la hot cache backend di `integration.orders`;
  - `fresh` resta il solo bypass esplicito, quindi il canary continua a misurare
    una lettura reale non cache.

Rollback:

- ripristinare `shouldUseRelationalOrdersHistoryRead` per consentire lo storico
  anche con `orderId`;
- ripristinare il bypass `_` in `handleIntegrationOrders`.

## Test

Eseguiti sul Raspberry `192.168.0.67`:

- `node --check backend/server.js`
- `node --check backend/modules/integration/scoped-orders-read.js`
- `node --test backend/tests/scoped-orders-read.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`

Risultato:

- 137/137 pass.
- `server.js`: 38.792 righe, budget M5 verde.

## Canary

Comando: `scripts/order-worker-sync-e2e-batch-canary.mjs`

Parametri:

- 50 iterazioni
- concorrenza 1
- login `amalia`
- tavolo `room_attesa_virtuale_t03`
- postazioni simulate: `BAR PRINCIPALE`, `CUCINA`
- stampa/fiscale/cassa reale disattivati

Risultato:

- Verdict: PASS
- OK: 50/50
- `create` p95: 501.26 ms
- `sync` p95: 228.66 ms
- `readback` p95: 37.56 ms
- `cleanup` p95: 871.12 ms

Confronto con P3.67:

- P3.67 `readback` p95: 551.57 ms
- P3.68 `readback` p95: 37.56 ms
- Delta: -514.01 ms
- Miglioramento: -93.19%

## Metriche Runtime

Snapshot: `reports/p3_68_readback_lookup_20260709/runtime_metrics.json`

- `GET /api/integration/orders` sui due worker:
  - 25 richieste per worker;
  - p95 bucket 25 ms;
  - `readDb` p95 0;
  - `writeDb` p95 0.
- `integrationOrdersFastCacheMisses`: 25 + 25.
- `integrationOrdersFastCacheHits`: 0 + 0.

Nota: zero hit e' atteso, perche' il canary passa `fresh`; quindi il risultato
`readback` non dipende dalla cache.

## Stato Gate

Gate readback: verde.

Prossimo collo:

- `cleanup`/`orders.cancel`, p95 871.12 ms;
- `create` p95 501.26 ms in questo run ha due spike iniziali/outlier e va
  riverificato dopo P3.69.

## Evidenze

- Report canary: `reports/p3_68_readback_lookup_20260709/order-worker-sync-e2e-batch-p3_68_readback_lookup_c1_50_20260709/REPORT.md`
- JSON canary: `reports/p3_68_readback_lookup_20260709/order-worker-sync-e2e-batch-p3_68_readback_lookup_c1_50_20260709/result.json`
- Runtime metrics: `reports/p3_68_readback_lookup_20260709/runtime_metrics.json`
- Sintesi metriche: `reports/p3_68_readback_lookup_20260709/runtime_metrics_summary.json`
