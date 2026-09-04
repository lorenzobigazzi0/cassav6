# Fase P3.67 - Order Create Delta Before Snapshot

Data: 2026-07-09

## Obiettivo

Ridurre il costo residuo di `orders/create -> financialSnapshotRead`, che dopo P3.66c restava con p95 bucket 250 ms.

## Implementazione

- Aggiunto `buildOrderCreateFinancialDeltaBeforeSnapshotFastPath` in `backend/modules/integration/order-financial-sync-source.js`.
- `orders/create` ora prova il delta economico prima di leggere lo snapshot ordini relazionale.
- Il delta before-snapshot e' ammesso solo se:
  - il target e' un singolo tavolo;
  - il tavolo esiste nel `posSettings` locale;
  - il token di revisione letto dal relazionale esiste;
  - la revisione locale del tavolo coincide con la revisione relazionale.
- Se il guard non passa, il percorso torna al comportamento precedente: legge `listRelationalOrderWorkflowSnapshot`, costruisce `buildOrderFinancialSyncState` e poi usa delta o sync completo.
- Rollback:
  - `BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT=0`

## Test

Eseguiti sul Raspberry `192.168.0.67`:

- `node --check backend/server.js`
- `node --test backend/tests/order-financial-sync-source.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`
- Risultato: 133/133 pass.
- `server.js`: 38.793 righe, margine M5 verde.

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
- `create` p95: 177.31 ms
- `sync` p95: 164.02 ms
- `readback` p95: 551.57 ms
- `cleanup` p95: 695.34 ms

Confronto con P3.66c:

- P3.66c `create` p95: 475.84 ms
- P3.67 `create` p95: 177.31 ms
- Delta: -298.53 ms
- Miglioramento: -62.74%

## Metriche Runtime

Snapshot: `reports/p3_67_delta_before_snapshot_20260709/runtime_metrics.json`

- `orderCreateFinancialDeltaBeforeSnapshotHits`: 53
- `orderCreateFinancialDeltaBeforeSnapshotFallbacks`: 2
- `orderCreateFinancialDeltaFastPathHits`: 55
- `orderCreateFinancialDeltaFastPathFallbacks`: 0
- `orderCreateInternal:financialSnapshotRead`:
  - p95 bucket 5 ms
  - max 201 ms su fallback
- `orders.create.relationalFinancialTableGuardRead`:
  - p95 bucket 1 ms

Nota: i counter runtime possono includere il mini-run diagnostico da 5 quando il reset peer non azzera tutti i worker; il canary finale resta 50/50 PASS.

## Stato Gate

Gate P3 create p95 < 500 ms: verde con margine ampio.

Prossimi colli:

- `readback` p95 551.57 ms;
- `cleanup` p95 695.34 ms;
- spike occasionale create p99 479.33 ms.
