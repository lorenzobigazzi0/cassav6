# Fase P3.57 - Orders Sync Financial No-op Fast Path

Data: 2026-07-09  
Target: Raspberry `192.168.0.67`  
Profilo test: stampa, fiscale e cassa automatica reale disattivati.

## Obiettivo

Ridurre il costo dominante di `orders/sync` individuato in P3.56:
`orderSyncInternal:financialSync`, che sui worker pesava circa 190-208 ms medi
per sync anche quando lo stato economico del tavolo non cambiava.

## Implementazione

- Aggiunto `buildOrderSyncFinancialNoopFastPath` in
  `backend/modules/integration/order-financial-sync-source.js`.
- Il fast path salta il sync economico solo se:
  - il flag `BACKEND_ORDERS_SYNC_FINANCIAL_NOOP_FASTPATH` non e' `0`;
  - ordine corrente e ordine merged hanno stessa firma economica;
  - non ci sono `queuePromotions` o `selectionHandoffDemotions`;
  - il tavolo target e' coerente con lo stato economico corrente.
- In caso di skip viene registrata la metrica:
  `orderWorkflow:orders.sync.financialNoopFastPath`.
- Il percorso completo precedente resta invariato come fallback:
  `listRelationalOrderWorkflowSnapshot` +
  `syncPosTableFinancialsFromIntegrationOrders` +
  `persistRelationalOrderFinancialTables`.
- Il profilo systemd P3 esplicita il flag:
  `BACKEND_ORDERS_SYNC_FINANCIAL_NOOP_FASTPATH=1`.

Rollback:

```bash
sudo systemctl edit cassav4-backend.service cassav4-api-worker@.service
# oppure nel drop-in P3:
# Environment=BACKEND_ORDERS_SYNC_FINANCIAL_NOOP_FASTPATH=0
sudo systemctl daemon-reload
sudo systemctl restart cassav4-backend.service cassav4-api-worker@5283.service cassav4-api-worker@5284.service
```

## Test

Sul Raspberry:

- `node --check backend/server.js` -> OK
- `node --check backend/modules/integration/order-financial-sync-source.js` -> OK
- `node --check backend/modules/runtime-metrics.js` -> OK
- `node --test --test-concurrency=1 backend/tests/order-financial-sync-source.test.mjs` -> 5/5
- `node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs` -> 107/107

Budget `server.js`: `38.796` righe, ancora dentro il limite M5.

## Deploy

Drop-in e codice deployati sul Raspberry.

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`

Health post restart:

- `5281` owner -> OK
- `5283` worker -> OK
- `5284` worker -> OK
- `5280` HTTPS proxy -> OK

Variabili di sicurezza confermate su owner e worker:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

## Canary 50

Report remoto:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_57_financial_noop_c1_50_20260709`

Risultato:

| Step | OK | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| P3.56 baseline | 50/50 | 862.98 ms | 782.59 ms | 383.80 ms | 341.17 ms |
| P3.57 | 50/50 | 994.54 ms | 866.27 ms | 427.57 ms | 427.63 ms |

Routing:

- `create`: 50/50 su `api-worker`
- `sync`: 50/50 su `api-worker`
- `cleanup`: 50/50 su `api-worker`
- `readback`: 50/50 su `api-worker`

## Metriche Runtime

Monitor owner:

- `workerCollection`: enabled `true`, expected `2`, collected `2`, failed `0`
- `ordersAsyncFlushRetries`: `0`
- `ordersAsyncFlushBackpressureSync`: `0`
- `eventOutboxPublishFailed`: `0`

Worker `5283`:

- `orderSyncTableStateChanged`: `1`
- `orderSyncTableStateNoops`: `24`
- `orderWorkflow:orders.sync.financialNoopFastPath`: count `24`
- `orderSyncInternal:financialSync`: avg `10.92 ms`, p95 bucket `5 ms`
- `orderSyncInternal:realtimeTableSnapshot`: avg `228.32 ms`, p95 bucket `500 ms`
- `orderSyncInternal:relationalSnapshotRead`: avg `158.16 ms`, p95 bucket `250 ms`
- `orderSyncInternal:preparationPlan`: avg `98.24 ms`, p95 bucket `250 ms`
- `orderSyncInternal:queueReconcile`: avg `83.20 ms`, p95 bucket `250 ms`

Worker `5284`:

- `orderSyncTableStateChanged`: `0`
- `orderSyncTableStateNoops`: `25`
- `orderWorkflow:orders.sync.financialNoopFastPath`: count `25`
- `orderSyncInternal:financialSync`: avg `0.28 ms`, p95 bucket `1 ms`
- `orderSyncInternal:realtimeTableSnapshot`: avg `235.00 ms`, p95 bucket `500 ms`
- `orderSyncInternal:relationalSnapshotRead`: avg `157.24 ms`, p95 bucket `250 ms`
- `orderSyncInternal:preparationPlan`: avg `102.48 ms`, p95 bucket `250 ms`
- `orderSyncInternal:queueReconcile`: avg `87.04 ms`, p95 bucket `250 ms`

Warning post-canary: `0` righe rilevanti.

## Valutazione

P3.57 e' un PASS tecnico sul bersaglio interno: il fast path ha preso 49 sync su
50 e ha portato `financialSync` da circa 190-208 ms medi a praticamente zero sui
no-op economici.

Non e' invece un gate-latency PASS end-to-end: il canary p95 resta piu' alto di
P3.56. Questo non indica regressione del fast path, ma spostamento del collo:
dopo la rimozione del costo economico, i costi dominanti sono ora
`realtimeTableSnapshot` e `relationalSnapshotRead`.

Prossimo step consigliato P3.58:

1. ridurre o rendere snapshot-ready `orderSyncInternal:realtimeTableSnapshot`;
2. poi comprimere `orders.sync.relationalSnapshotRead`, che resta a circa
   157-158 ms medi per worker.

## Artefatti

- `reports/p3_57_financial_noop_20260709/canary_result.json`
- `reports/p3_57_financial_noop_20260709/p3-57-canary-report.tgz`
- `reports/p3_57_financial_noop_20260709/runtime_metrics_aggregated.json`
- `reports/p3_57_financial_noop_20260709/runtime_metrics_summary.json`
- `reports/p3_57_financial_noop_20260709/p3-57-services.txt`
- `reports/p3_57_financial_noop_20260709/post_canary_recent_warnings.txt`
