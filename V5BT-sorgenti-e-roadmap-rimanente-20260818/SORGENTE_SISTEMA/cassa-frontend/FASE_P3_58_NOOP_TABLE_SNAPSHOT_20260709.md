# Fase P3.58 - No-op Table Snapshot Fast Path

Data: 2026-07-09  
Target: Raspberry `192.168.0.67`  
Profilo test: stampa, fiscale e cassa automatica reale disattivati.

## Obiettivo

Ridurre il collo emerso in P3.57:
`orderSyncInternal:realtimeTableSnapshot`, che costava circa 228-235 ms medi per
worker dopo avere reso quasi nullo `financialSync`.

## Implementazione

- Aggiunto `addOrderSyncFinancialNoopTableSnapshot` in
  `backend/modules/integration/order-financial-sync-source.js`.
- Quando `orders/sync` salta il financial sync per no-op economico, viene
  agganciata alla `Map` `financialSync.tableSnapshotsById` una snapshot tavolo
  lightweight presa da `findIntegrationLayoutTableFromSettings(settings, tableId)`.
- Il fallback legacy resta invariato:
  `findIntegrationLayoutTableSnapshot(db, mergedOrder.tableId)`.
- Il nuovo fast path e' attivo solo se:
  `BACKEND_ORDERS_SYNC_NOOP_TABLE_SNAPSHOT !== "0"`.

Rollback:

```bash
sudo systemctl edit cassav4-backend.service cassav4-api-worker@.service
# oppure nel drop-in P3:
# Environment=BACKEND_ORDERS_SYNC_NOOP_TABLE_SNAPSHOT=0
sudo systemctl daemon-reload
sudo systemctl restart cassav4-backend.service cassav4-api-worker@5283.service cassav4-api-worker@5284.service
```

Backup remoto dei file toccati:

`/opt/cassav4/backups/p3-58-noop-table-snapshot-20260709-135535`

## Test

Sul Raspberry:

- `node --check backend/server.js` -> OK
- `node --check backend/modules/integration/order-financial-sync-source.js` -> OK
- `node --test --test-concurrency=1 backend/tests/order-financial-sync-source.test.mjs` -> 6/6
- `node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs` -> 108/108

Budget `server.js`: `38.797` righe, ancora dentro il limite M5.

## Deploy

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`

Health post restart:

- `5280` HTTPS proxy -> OK
- `5283` worker -> OK
- `5284` worker -> OK

Variabili di sicurezza confermate:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

## Canary 50

Report remoto:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_58_noop_table_snapshot_c1_50_20260709`

Risultato:

| Step | OK | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| P3.56 | 50/50 | 862.98 ms | 782.59 ms | 383.80 ms | 341.17 ms |
| P3.57 | 50/50 | 994.54 ms | 866.27 ms | 427.57 ms | 427.63 ms |
| P3.58 | 50/50 | 916.96 ms | 562.32 ms | 424.65 ms | 419.25 ms |

Delta:

- `sync p95` vs P3.57: `-35.09%`
- `sync p95` vs P3.56: `-28.15%`
- `create p95` vs P3.57: `-7.80%`
- `readback p95` vs P3.57: `-0.68%`
- `cleanup p95` vs P3.57: `-1.96%`

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
- `orderSyncInternal:realtimeTableSnapshot`: avg `0.00 ms`, p95 bucket `1 ms`
- `orderSyncInternal:relationalSnapshotRead`: avg `165.24 ms`, p95 bucket `250 ms`
- `orderSyncInternal:preparationPlan`: avg `99.00 ms`, p95 bucket `250 ms`
- `orderSyncInternal:queueReconcile`: avg `87.84 ms`, p95 bucket `250 ms`

Worker `5284`:

- `orderSyncTableStateChanged`: `0`
- `orderSyncTableStateNoops`: `25`
- `orderWorkflow:orders.sync.financialNoopFastPath`: count `25`
- `orderSyncInternal:realtimeTableSnapshot`: avg `0.00 ms`, p95 bucket `1 ms`
- `orderSyncInternal:relationalSnapshotRead`: avg `158.28 ms`, p95 bucket `250 ms`
- `orderSyncInternal:preparationPlan`: avg `112.04 ms`, p95 bucket `250 ms`
- `orderSyncInternal:queueReconcile`: avg `88.28 ms`, p95 bucket `250 ms`

Warning post-canary: solo log attesi di modalita test (`STAMPA DISABILITATA`,
I/O fiscale disabilitato, maintenance disabilitata).

## Valutazione

P3.58 e' un PASS tecnico e un PASS di latenza sul tratto `orders/sync`: il costo
`realtimeTableSnapshot` e' stato eliminato dal percorso caldo no-op e il p95 sync
e' sceso da `866.27 ms` a `562.32 ms`.

Il prossimo collo e' ora stabile e misurato:

1. `orders.sync.relationalSnapshotRead`: circa `158-165 ms` medi per worker;
2. `preparationPlan`: circa `99-112 ms` medi;
3. `queueReconcile`: circa `88 ms` medi.

Prossimo step consigliato P3.59: ridurre `orders.sync.relationalSnapshotRead`,
idealmente riusando il target order gia' letto o introducendo una vista ancora
piu' stretta per il sync no-op.

## Artefatti

- `reports/p3_58_noop_table_snapshot_20260709/canary_result.json`
- `reports/p3_58_noop_table_snapshot_20260709/p3-58-canary-report.tgz`
- `reports/p3_58_noop_table_snapshot_20260709/runtime_metrics_aggregated.json`
- `reports/p3_58_noop_table_snapshot_20260709/runtime_metrics_summary.json`
- `reports/p3_58_noop_table_snapshot_20260709/p3-58-services.txt`
- `reports/p3_58_noop_table_snapshot_20260709/post_canary_recent_warnings.txt`
