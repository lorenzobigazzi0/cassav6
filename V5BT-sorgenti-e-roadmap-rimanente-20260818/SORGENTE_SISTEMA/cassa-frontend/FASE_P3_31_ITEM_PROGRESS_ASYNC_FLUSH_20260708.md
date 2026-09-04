# Fase P3.31 - Item progress fastcheck e coalescenza flush async

Data: 2026-07-08
Target: Raspberry `192.168.0.67`

## Obiettivo

Ridurre lavoro CPU residuo nel path `orders/sync` dopo P3.30, partendo dal punto indicato dal report precedente: audit diff/item progress e pressione del mirror app-state asincrono.

## Modifiche

- `backend/modules/orders/order-progress.js`
  - aggiunto `hasIntegrationItemProgressAuditChange(previousOrder, nextOrder)`;
  - confronto leggero sui campi normalizzati gia' usati dallo snapshot audit: `id`, `lineId`, `qty`, `done`, `doneQty`, `voided`.
- `backend/server.js`
  - rimosso il doppio snapshot sempre attivo su `orders/sync`;
  - gli snapshot completi `buildIntegrationItemProgressAuditSnapshot(...)` vengono costruiti solo quando il fastcheck rileva una variazione reale.
- `backend/tests/order-progress.test.mjs`
  - aggiunti test per no-op normalizzato e cambi reali di quantita/stato/void.
- `deploy/systemd/50-p3-orders-write-primary.conf`
  - `ORDERS_ASYNC_FLUSH_INTERVAL_MS` portato da `100` a `500` ms per coalescere meglio i flush mirror in background.

## Verifiche statiche e unit

Eseguite sul Raspberry come utente `cassav4`:

- `node --check backend/modules/orders/order-progress.js`: OK
- `node --check backend/server.js`: OK
- `wc -l backend/server.js`: `38788`
- `node --test backend/tests/order-progress.test.mjs`: 6/6 OK
- `node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs`: 89/89 OK

Servizi riavviati:

- `cassav4-backend.service`: active
- `cassav4-api-worker@5283.service`: active
- `cassav4-api-worker@5284.service`: active

Log avvio confermato:

- `flushInterval=500ms`
- write-primary relazionale e async ACK attivi
- stampa/fiscale reale disabilitati per il test

## Canary

Il primo run con lista `room_pedana_t01..30` e' fallito 40/50 per dataset non valido nella release corrente:

- tavoli mancanti: `room_pedana_t21..30`
- cleanup harness postazioni: OK

Il run valido usa `room_pedana_t01..20`, ripetuti sulle 50 iterazioni.

### Prima del cambio flush 500ms

Run: `p3_31_item_progress_fastcheck_c3_50x_valid20_20260708`

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 | 0 | 2299.05 ms | 2981.74 ms | 2059.53 ms | 1202.09 ms |

### Dopo flush 500ms

Run: `p3_31_async_flush_500ms_c3_50x_valid20_20260708`

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 | 0 | 2715.14 ms | 2674.18 ms | 1753.79 ms | 1705.08 ms |

Stato finale:

- `/api/integration/stations/active`: `stations: []`
- `app_table_work_locks`: `0`
- health proxy/backend: OK

## Lettura metriche

Dopo reset metriche e run con flush 500ms:

- worker 5283:
  - `ordersAsyncFlushEnqueued`: 77
  - `ordersAsyncFlushBatches`: 53
  - `ordersAsyncFlushRetries`: 0
  - top p95: `orders.asyncFlush.queueWait`, `integration.bulkEntries`, `posSettingsTables`
- worker 5284:
  - `ordersAsyncFlushEnqueued`: 73
  - `ordersAsyncFlushBatches`: 52
  - `ordersAsyncFlushRetries`: 0
  - top p95: `orders.asyncFlush.appStateWrite`, `orders.asyncFlush.mysqlLockWait`, `posSettingsTables`

Il cambio a 500ms elimina i retry osservati nel run precedente e migliora `sync`/`cleanup`, ma non basta per il target sub-secondo.

## Decisione tecnica

La patch item-progress e' corretta e a basso rischio, ma il collo misurato ora e' il mirror async multi-worker:

- batch ancora numerosi rispetto agli enqueue;
- `posSettingsTables` e `integration.bulkEntries` restano costosi;
- il lock MySQL inter-worker non e' piu' sempre dominante, ma rimane visibile.

## Prossimo step consigliato

P3.32: togliere ulteriore lavoro dal flush async:

1. separare il mirror `posSettingsTables/table_state` dagli ordini quando il relazionale e' gia' write-primary;
2. oppure centralizzare il flush mirror su un solo processo owner/outbox consumer, lasciando ai worker solo l'ACK relazionale;
3. aggiungere metriche foreground dentro `handleIntegrationOrderSync` prima della write per distinguere route transition, financial sync e publish realtime.

