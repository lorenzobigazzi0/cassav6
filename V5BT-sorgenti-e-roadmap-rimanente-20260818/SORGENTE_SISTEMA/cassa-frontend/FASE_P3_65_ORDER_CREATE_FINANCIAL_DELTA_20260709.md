# Fase P3.65 - Order Create Financial Delta Fast Path

Data: 2026-07-09

## Obiettivo

Ridurre il costo CPU di `orders/create` rimuovendo dal percorso caldo il `financialSync` completo quando l'ordine appena creato tocca un solo tavolo non accorpato.

## Implementazione

- Aggiunto `buildOrderCreateFinancialDeltaFastPath` in `backend/modules/integration/order-financial-sync-source.js`.
- Agganciato `orders/create` in `backend/server.js` con rollback:
  - `BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_FASTPATH=0`
- Il fast path copre:
  - ordine pagabile con pending bill incrementale;
  - ordine `waiting/prep` non ancora pagabile quando `requireDeliveredForPayment=true`, aggiornando solo lo stato tavolo a `waiting`.
- Fallback automatico al sync completo per:
  - target non singolo;
  - tavoli collegati;
  - tavolo non trovato;
  - ordine non pagabile e non in progress.
- Aggiunte metriche runtime:
  - `orderCreateFinancialDeltaFastPathHits`
  - `orderCreateFinancialDeltaFastPathFallbacks`
  - `orderWorkflow:orders.create.financialDelta.<reason>`

## Test

Eseguiti sul Raspberry `192.168.0.67`:

- `node --check backend/server.js`
- `node --test backend/tests/order-financial-sync-source.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`
- Suite mirata finale: 123/123 pass.

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
- `create` p95: 435.13 ms
- `sync` p95: 475.87 ms
- `readback` p95: 466.88 ms
- `cleanup` p95: 575.94 ms

Confronto con P3.64:

- P3.64 `create` p95: 755.02 ms
- P3.65 `create` p95: 435.13 ms
- Delta: -319.89 ms
- Miglioramento: -42.37%

## Metriche Runtime

Snapshot: `reports/p3_65_order_create_financial_delta_20260709/runtime_metrics_summary.json`

- Hit osservati: 55
- Fallback osservati: 0
- Nota: i counter includono il mini-run diagnostico da 5 piu' il canary finale da 50, perche' il reset owner non azzera sempre i peer worker.
- `financialSync` osservato sul worker con label disponibile:
  - avg 0.54 ms
  - p95 5 ms
  - max 2 ms

## Stato Gate

Gate P3 create p95 < 500 ms: verde.

## Prossimo Collo

Il costo residuo piu' evidente su `orders/create` non e' piu' `financialSync`.
Restano candidati:

- `auditPrelude` p95 bucket 250 ms;
- `financialSnapshotRead` p95 bucket 250 ms;
- `idempotency` p95 bucket 100 ms.

Prossimo step consigliato: P3.66 su `auditPrelude`, con fast path per ridurre la scansione audit pre-creazione o renderla incrementale per ordine.
