# Fase P3.33 - skip mirror async posSettingsTables

Data: 2026-07-08
Target: Raspberry `192.168.0.67`

## Obiettivo

Ridurre il lavoro del mirror async ordini dopo P3.32. Ora `orders/sync` persiste ordine e `table_state` relazionali prima del mirror app-state; quindi, quando layout/tavoli leggono dal relazionale, il flush async puo' saltare `mysql.posSettingsTables`.

## Modifiche

- `backend/server.js`
  - aggiunto flag effettivo `ORDERS_ASYNC_FLUSH_SKIP_POSSETTINGS_TABLES`;
  - il flag e' valido solo se:
    - `ORDERS_ASYNC_FLUSH_SKIP_POSSETTINGS_TABLES=1`;
    - `RELATIONAL_TABLES_READ_PRIMARY` e' attivo;
    - `RELATIONAL_LAYOUT_TABLES_READ_PRIMARY` e' attivo;
    - `APP_STATE_TABLE_STATES_SPLIT_MODE === "externalized"`;
  - lo skip vale solo per `stepPrefix === "orders.asyncFlush"`;
  - il mirror sincrono/non-async continua a sincronizzare `posSettingsTables`.
- `backend/modules/runtime-metrics.js`
  - aggiunto counter `ordersAsyncFlushPosSettingsTablesSkipped`.
- `deploy/systemd/50-p3-orders-write-primary.conf`
  - aggiunto `Environment=ORDERS_ASYNC_FLUSH_SKIP_POSSETTINGS_TABLES=1`.
- `backend/tests/route-policy-architecture.test.mjs`
  - aggiunto gate `P3.33 il mirror async posSettingsTables si salta solo dietro read-primary tavoli`.

## Verifiche

Eseguite sul Raspberry come utente `cassav4`:

- `node --check backend/server.js`: OK
- `node --check backend/modules/runtime-metrics.js`: OK
- `wc -l backend/server.js`: `38790`
- `node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs`: 91/91 OK
- `node --test backend/tests/runtime-metrics.test.mjs backend/tests/orders-flow.e2e.test.mjs`: 13/13 OK

Servizi riavviati:

- `cassav4-backend.service`: active
- `cassav4-api-worker@5283.service`: active
- `cassav4-api-worker@5284.service`: active

Environment confermata su worker:

- `ORDERS_ASYNC_FLUSH_INTERVAL_MS=500`
- `ORDERS_ASYNC_FLUSH_SKIP_POSSETTINGS_TABLES=1`
- `ORDERS_ASYNC_FLUSH_MYSQL_LOCK=1`
- `ORDERS_ASYNC_FLUSH_MYSQL_LOCK_TIMEOUT_SEC=3`

## Canary

Run: `p3_33_skip_possettings_async_c3_50x_valid20_20260708`

- Iterazioni: 50
- Concorrenza: 3
- Postazioni harness: `BAR PRINCIPALE`, `CUCINA`
- Tavoli validi: `room_pedana_t01..room_pedana_t20`

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 | 0 | 3055.02 ms | 2597.46 ms | 1753.44 ms | 1081.14 ms |

Dettaglio:

- `create` avg 1484.94 ms, p50 1223.05 ms, p99 4633.62 ms
- `sync` avg 2046.39 ms, p50 1987.26 ms, p99 2989.41 ms
- `readback` avg 552.95 ms, p50 502.53 ms, p99 1364.61 ms
- `cleanup` avg 589.54 ms, p50 450.15 ms, p99 2495.41 ms

Report canary:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_33_skip_possettings_async_c3_50x_valid20_20260708`

## Metriche post-run

Worker `5283`:

- `ordersAsyncFlushEnqueued`: 69
- `ordersAsyncFlushBatches`: 55
- `ordersAsyncFlushRetries`: 0
- `ordersAsyncFlushPosSettingsTablesSkipped`: 46

Worker `5284`:

- `ordersAsyncFlushEnqueued`: 81
- `ordersAsyncFlushBatches`: 58
- `ordersAsyncFlushRetries`: 0
- `ordersAsyncFlushPosSettingsTablesSkipped`: 48

`mysql.posSettingsTables` non compare piu' nei top operations del flush async. I colli residui sono:

- `orders.asyncFlush.queueWait`;
- `orders.asyncFlush.mysqlLockWait`;
- `integration.bulkEntries`;
- `auditRecent` su alcuni outlier.

## Stato finale

- `/api/integration/stations/active`: `stations: []`
- `app_table_work_locks`: `0`
- Health proxy/backend: OK

## Confronto P3.32 -> P3.33

- `sync p95`: 2866.36 ms -> 2597.46 ms
- `cleanup p95`: 2044.96 ms -> 1753.44 ms
- `readback p95`: 1775.69 ms -> 1081.14 ms
- `create p95`: 2902.07 ms -> 3055.02 ms

Il cambio migliora sync/cleanup/readback e conferma che `posSettingsTables` era lavoro evitabile nel mirror async. Il target sub-secondo non e' ancora raggiunto: il prossimo collo e' il flush async multi-worker su `integration.bulkEntries`/audit e l'attesa lock.

## Prossimo step consigliato

P3.34:

1. centralizzare il flush mirror app-state ordini su owner/outbox consumer, togliendolo dai worker;
2. oppure aumentare la coalescenza cross-worker con una coda owner via Redis/outbox;
3. in parallelo, ridurre `auditRecent` usando solo `auditEventIds` quando presenti, evitando il fallback recente nel percorso async.

