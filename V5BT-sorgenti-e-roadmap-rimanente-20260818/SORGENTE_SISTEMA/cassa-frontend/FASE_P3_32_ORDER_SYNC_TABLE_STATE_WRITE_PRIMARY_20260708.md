# Fase P3.32 - orders/sync table_state write-primary

Data: 2026-07-08
Target: Raspberry `192.168.0.67`

## Obiettivo

Preparare il taglio del mirror async `posSettingsTables` spostando anche `orders/sync` sul modello write-primary relazionale per il table-state finanziario. Prima di saltare il mirror app-state serveva garantire che lo stato tavolo fosse gia' durevole nel relazionale.

## Modifiche

- `backend/server.js`
  - `orders/sync` ora scrive prima l'ordine relazionale con CAS;
  - rilegge uno snapshot ordini relazionale con metrica `orders.sync.relationalFinancialSnapshotRead`;
  - calcola `syncPosTableFinancialsFromIntegrationOrders(...)` sullo snapshot relazionale;
  - applica `captureRelationalOrderFinancialTableGuard(...)` + `applyOrderFinancialTableRevisionTokens(...)`;
  - persiste il table-state con `persistRelationalOrderFinancialTables(...)` prima del mirror app-state asincrono.
- `backend/tests/route-policy-architecture.test.mjs`
  - aggiunto gate `P3.32 orders/sync persiste table_state relazionale prima del mirror app-state`.

## Verifiche

Eseguite sul Raspberry come utente `cassav4`:

- `node --check backend/server.js`: OK
- `wc -l backend/server.js`: `38789`
- `node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs`: 90/90 OK
- `node --test backend/tests/orders-flow.e2e.test.mjs`: 8/8 OK

Servizi riavviati:

- `cassav4-backend.service`: active
- `cassav4-api-worker@5283.service`: active
- `cassav4-api-worker@5284.service`: active

Config confermata:

- `flushInterval=500ms`
- async ACK attivo
- stampa/fiscale/cassa reale disabilitati nei canary

## Canary

Run: `p3_32_sync_table_state_wp_c3_50x_valid20_20260708`

- Iterazioni: 50
- Concorrenza: 3
- Postazioni harness: `BAR PRINCIPALE`, `CUCINA`
- Tavoli validi: `room_pedana_t01..room_pedana_t20`

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 | 0 | 2902.07 ms | 2866.36 ms | 2044.96 ms | 1775.69 ms |

Dettaglio:

- `create` avg 1472.10 ms, p50 1378.34 ms, p99 4565.51 ms
- `sync` avg 1931.08 ms, p50 1812.02 ms, p99 3046.75 ms
- `readback` avg 593.36 ms, p50 460.80 ms, p99 1960.72 ms
- `cleanup` avg 718.53 ms, p50 513.77 ms, p99 3044.06 ms

Report canary:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_32_sync_table_state_wp_c3_50x_valid20_20260708`

## Stato finale

- `/api/integration/stations/active`: `stations: []`
- `app_table_work_locks`: tornato a `0`
- Nota: dopo il run era rimasto un lock canary scaduto su `room_pedana_t05`, purpose `mp4.order.sync.canary.cleanup`; e' stato rilasciato via API `/api/tables/lock/force-release`, non con delete diretto DB.
- Health proxy/backend: OK

## Lettura metriche

Il canary e' verde e il table-state e' ora write-primary anche in `orders/sync`, ma le latenze non migliorano. Questo e' atteso: P3.32 aggiunge durabilita' foreground e non rimuove ancora lavoro dal mirror.

Metriche post-run:

- worker 5283:
  - `ordersAsyncFlushEnqueued`: 71
  - `ordersAsyncFlushBatches`: 50
  - `ordersAsyncFlushRetries`: 5
  - p95 alti: `orders.asyncFlush.mysqlLockWait`, `orders.asyncFlush.queueWait`, `integration.bulkEntries`
- worker 5284:
  - `ordersAsyncFlushEnqueued`: 79
  - `ordersAsyncFlushBatches`: 50
  - `ordersAsyncFlushRetries`: 0
  - p95 alti: `orders.asyncFlush.queueWait`, `integration.bulkEntries`, `posSettingsTables`

## Decisione tecnica

P3.32 e' un prerequisito di correttezza per il prossimo taglio performance: adesso `orders/sync` ha ordine e table-state durevoli nel relazionale prima del mirror app-state.

Il collo resta il mirror async multi-worker. Il prossimo step consigliato e' P3.33:

1. introdurre un flag per saltare `mysql.posSettingsTables` nel flush async degli ordini quando `RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY` e `RELATIONAL_TABLES_READ_PRIMARY` sono attivi;
2. lasciare il mirror full solo come fallback/compatibilita';
3. aggiungere metrica dedicata per `orders.asyncFlush.posSettingsTablesSkipped`.

