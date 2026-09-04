# Fase P3.66c - Order Create Targeted Queue Reconcile

Data: 2026-07-09

## Obiettivo

Ridurre il costo CPU di `orders/create` nel tratto `auditPrelude`, dove il breakdown P3.66 mostrava `queueReconcile` a circa 140-170 ms medi per creazione.

## Implementazione

- Aggiunto `buildCreatedOrderPreparationQueueFastPlan` in `backend/modules/orders/order-preparation-queue.js`.
- `orders/create` ora prova una riconciliazione mirata alla sola lane della nuova comanda:
  - se la lane ha gia' una comanda `prep`, evita la riconciliazione globale;
  - se la nuova comanda e' la prima `waiting` della lane, la promuove direttamente;
  - se il caso e' ambiguo, torna alla riconciliazione completa.
- Rollback:
  - `BACKEND_ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP=0`
- Metriche runtime:
  - `orderCreateQueueReconcileFastSkips`
  - `orderCreateQueueReconcileFastFallbacks`

## Test

Eseguiti sul Raspberry `192.168.0.67`:

- `node --check backend/server.js`
- `node --test backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`
- Risultato: 115/115 pass.
- `server.js`: 38.799 righe, margine M5 sopra 700 righe.

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
- `create` p95: 475.84 ms
- `sync` p95: 109.68 ms
- `readback` p95: 558.34 ms
- `cleanup` p95: 667.99 ms

## Metriche Runtime

Snapshot: `reports/p3_66c_create_queue_targeted_reconcile_20260709/runtime_metrics.json`

- `orderCreateQueueReconcileFastSkips`: 55
- `orderCreateQueueReconcileFastFallbacks`: 0
- `orderCreateFinancialDeltaFastPathHits`: 55
- `orderCreateFinancialDeltaFastPathFallbacks`: 0
- `orderCreateAuditPrelude:queueReconcile`:
  - avg 6.8-7.0 ms
  - p95 bucket 25 ms
- `orderCreateInternal:auditPrelude`:
  - avg 8.14 ms
  - p95 bucket 25 ms

## Stato Gate

Gate P3 create p95 < 500 ms: verde.

Nota: il `create` p95 complessivo resta poco sotto soglia per spike non piu' legati a `auditPrelude`; il collo successivo e' `financialSnapshotRead` con p95 bucket 250 ms, seguito da spike occasionali su `realtimePublish` e `relationalPrimary`.
