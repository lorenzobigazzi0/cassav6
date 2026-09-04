# Fase P3.35 - Remote owner async app-state flush

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`

## Obiettivo

Centralizzare il mirror app-state asincrono degli ordini sull'owner backend, evitando che gli `api-worker` scrivano direttamente il mirror MySQL quando il profilo multi-processo e' attivo.

## Modifiche

- Aggiunta route interna service-token:
  - `POST /api/internal/orders/async-appstate-flush`
  - handler key `integration.orderAsyncAppStateFlush`
- Aggiunto modulo `backend/modules/integration/order-async-owner-flush.js`.
- Gli `api-worker`, solo dietro flag, inoltrano il batch async flush all'owner `5281`.
- Se l'owner non risponde, resta fallback locale sul worker.
- Il route guard classifica la route come `internal-service`, ammessa su owner e worker ma con handler operativo solo sull'owner.
- Metriche aggiunte:
  - `ordersAsyncFlushRemoteOwnerForwarded`
  - `ordersAsyncFlushRemoteOwnerAccepted`
  - `ordersAsyncFlushRemoteOwnerFallbacks`
  - `ordersAsyncFlushRemoteOwnerHandled`
- Drop-in systemd aggiornato:
  - `ORDERS_ASYNC_FLUSH_REMOTE_OWNER=1`
  - `ORDERS_ASYNC_FLUSH_OWNER_URL=http://127.0.0.1:5281`
  - `ORDERS_ASYNC_FLUSH_REMOTE_OWNER_TIMEOUT_MS=10000`

## Note sul timeout

Il primo deploy aveva timeout remoto a `1500ms`. Sul Raspberry l'owner impiegava spesso `3000-5700ms` per completare `POST /api/internal/orders/async-appstate-flush`; il worker abortiva, faceva fallback locale e l'owner continuava comunque a processare. Questo creava doppia pressione e il primo canary ha chiuso `16/20`.

Il timeout e' stato portato a `10000ms`: il percorso async resta bounded, ma non genera fallback mentre l'owner sta gia completando il lavoro.

## Test locali

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/integration/order-async-owner-flush.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/routes/route-handlers.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/process-topology.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/order-async-appstate-flush.test.mjs
```

Risultato:

- Syntax check: PASS
- Architecture/topology/route policy: `103/103 PASS`
- Runtime metrics + async flush queue: `13/13 PASS`
- `server.js`: `38797` righe, margine M5 `703`.

## Deploy Raspberry

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`
- `cassav4-battery.service`

Safety I/O reale:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

Health:

```json
{"ok":true,"service":"cash-backend","version":"0.0.2","database":{"ok":true,"mode":"mysql"},"environment":"production"}
```

Test sul Raspberry:

- Architecture/topology/route policy: `103/103 PASS`
- Runtime metrics + async flush queue: `13/13 PASS`
- Nessuna unit systemd fallita.

## Canary

Comando:

```bash
CANARY_FRONTEND_ORIGIN=https://127.0.0.1:5280 \
CANARY_USERNAME=amalia \
CANARY_PIN=182018 \
ORDER_E2E_BATCH_RUN_ID=p3_35_remote_owner_flush_c1_20_t10s_20260708 \
ORDER_E2E_BATCH_ITERATIONS=20 \
ORDER_E2E_BATCH_CONCURRENCY=1 \
ORDER_E2E_BATCH_TABLE_IDS=room_attesa_virtuale_t03 \
ORDER_E2E_BATCH_ACTIVE_STATIONS="BAR PRINCIPALE,CUCINA" \
PRINTING_ENABLED=0 \
FISCAL_REAL_IO_DISABLED=1 \
POS_FISCAL_REAL_IO_DISABLED=1 \
AUTOMATIC_CASH_REAL_ENABLED=0 \
/usr/local/bin/node scripts/order-worker-sync-e2e-batch-canary.mjs
```

Report:

- `/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_35_remote_owner_flush_c1_20_t10s_20260708`

Risultato:

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 20 | 0 | 1166.03ms | 1838.56ms | 441.15ms | 657.18ms |

Routing:

- create: `api-worker` 20/20
- sync: `api-worker` 20/20
- cleanup: `api-worker` 20/20
- readback: `api-worker` 20/20

Metriche runtime dopo il canary:

```json
{
  "owner": {
    "ordersAsyncFlushRemoteOwnerHandled": 44,
    "ordersAsyncFlushRemoteOwnerFallbacks": 0
  },
  "worker5283": {
    "ordersAsyncFlushRemoteOwnerForwarded": 23,
    "ordersAsyncFlushRemoteOwnerAccepted": 23,
    "ordersAsyncFlushRemoteOwnerFallbacks": 0
  },
  "worker5284": {
    "ordersAsyncFlushRemoteOwnerForwarded": 21,
    "ordersAsyncFlushRemoteOwnerAccepted": 21,
    "ordersAsyncFlushRemoteOwnerFallbacks": 0
  }
}
```

## Residuo / prossimo step

P3.35 e' verde, ma il prossimo collo di bottiglia e' chiaro: l'endpoint interno owner `POST /api/internal/orders/async-appstate-flush` impiega spesso `3-5.7s` e, girando nella mutation queue owner, puo far aspettare login/logout/station state per circa `3s`.

Prossimo step consigliato: ridurre il costo dell'owner flush, ad esempio evitando `readDb({ forceReload: true })` completo per ogni batch remoto o spostando il mirror remoto su una lane/job owner dedicata con coalescing lato owner.
