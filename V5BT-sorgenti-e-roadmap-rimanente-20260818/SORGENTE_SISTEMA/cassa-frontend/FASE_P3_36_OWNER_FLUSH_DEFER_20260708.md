# Fase P3.36 - Owner flush remoto accodato e coalescente

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`

## Obiettivo

Ridurre il costo della route interna P3.35 `POST /api/internal/orders/async-appstate-flush`.

In P3.35 gli `api-worker` inoltravano correttamente all'owner, ma l'owner eseguiva il flush completo dentro la request interna. Sul Raspberry questo generava esecuzioni da `3-5.7s` e poteva far attendere login/logout/station state.

## Modifica

La handler `handleInternalOrderAsyncAppStateFlush` ora:

- valida che il processo sia owner;
- costruisce le opzioni con `buildRemoteOwnerFlushOptions`;
- incrementa `ordersAsyncFlushRemoteOwnerHandled`;
- prova `orderAsyncAppStateFlushQueue.tryDefer(options)`;
- se accodato, risponde `202` con `{ ok: true, deferred: true }`;
- usa il vecchio percorso sincrono solo in backpressure.

Nuove metriche:

- `ordersAsyncFlushRemoteOwnerDeferred`
- `ordersAsyncFlushRemoteOwnerSyncFallbacks`

La durabilita resta garantita dal write-primary relazionale precedente all'ACK del workflow ordine. Il mirror app-state rimane asincrono e coalescente.

## Test locali

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/process-topology.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/order-async-appstate-flush.test.mjs
```

Risultato:

- Syntax check: PASS
- Architecture/topology/route policy: `103/103 PASS`
- Runtime metrics + async flush queue: `13/13 PASS`
- `server.js`: `38797` righe, margine M5 invariato.

## Deploy Raspberry

File aggiornati:

- `backend/server.js`
- `backend/modules/runtime-metrics.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/runtime-metrics.test.mjs`

Servizi riavviati:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`

Safety I/O reale:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

Test sul Raspberry:

- Syntax check: PASS
- Architecture/topology/route policy: `103/103 PASS`
- Runtime metrics + async flush queue: `13/13 PASS`
- Health HTTPS: OK
- Unit systemd fallite: `0`

## Canary

Comando:

```bash
CANARY_FRONTEND_ORIGIN=https://127.0.0.1:5280 \
CANARY_USERNAME=amalia \
CANARY_PIN=182018 \
ORDER_E2E_BATCH_RUN_ID=p3_36_owner_flush_defer_c1_20_20260708 \
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

- `/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_36_owner_flush_defer_c1_20_20260708`

Risultato:

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 20 | 0 | 709.44ms | 1088.96ms | 255.07ms | 305.63ms |

Confronto con P3.35:

| Run | Durata | Create p95 | Sync p95 | Cleanup p95 |
| --- | --- | --- | --- | --- |
| P3.35 timeout 10s | 235.3s | 1166.03ms | 1838.56ms | 441.15ms |
| P3.36 deferred owner | 92.8s | 709.44ms | 1088.96ms | 255.07ms |

Miglioramento:

- durata batch: circa `-60.6%`;
- create p95: circa `-39.2%`;
- sync p95: circa `-40.8%`;
- cleanup p95: circa `-42.2%`.

## Metriche runtime post-canary

```json
{
  "owner": {
    "ordersAsyncFlushRemoteOwnerHandled": 41,
    "ordersAsyncFlushRemoteOwnerDeferred": 41,
    "ordersAsyncFlushRemoteOwnerSyncFallbacks": 0,
    "ordersAsyncFlushBatches": 39,
    "ordersAsyncFlushBackpressureSync": 0
  },
  "worker5283": {
    "ordersAsyncFlushRemoteOwnerForwarded": 20,
    "ordersAsyncFlushRemoteOwnerAccepted": 20,
    "ordersAsyncFlushRemoteOwnerFallbacks": 0
  },
  "worker5284": {
    "ordersAsyncFlushRemoteOwnerForwarded": 21,
    "ordersAsyncFlushRemoteOwnerAccepted": 21,
    "ordersAsyncFlushRemoteOwnerFallbacks": 0
  }
}
```

Log:

- nessun fallback `orders:async-flush`;
- nessun `POST /api/internal/orders/async-appstate-flush` lungo dopo la patch;
- rimane un singolo `station-state-lane` lungo da `3103ms`, non bloccante per il canary.

## Residuo / prossimo step

Il percorso remote-owner e' ora verde e molto piu leggero. Il prossimo collo di bottiglia da affrontare e' la latenza residua di `orders/sync` e il singolo picco `station-state-lane`: conviene profilare o isolare ulteriormente station state/presence dal traffico ordine, mantenendo il modello owner-deferred appena introdotto.
