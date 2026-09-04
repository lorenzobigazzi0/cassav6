# Fase P3.22 - Order worker e2e latency baseline

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Release runtime: `/opt/cassav4/current/cassa-frontend`

## Obiettivo

Validare il percorso e2e `orders/create -> orders/sync -> orders/cancel` con mutazioni instradate su `api-worker`, stampa/fiscale/cassa reale disattivati, e raccogliere un baseline di latenza dopo l'attivazione del multi-process order worker.

## Bug trovati e corretti

1. `orders/create` lasciava un lock tavolo temporaneo `order.create` quando la create acquisiva internamente il lock.
   - Fix: se il lock e' temporaneo, viene rilasciato prima della persistenza finale.

2. Con `BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1`, il flush asincrono poteva riscrivere in `posSettings.tables` un `workLock` gia' rilasciato.
   - Fix: `syncPosSettingsTablesFastPath` sincronizza una vista senza `workLock` quando i lock sono esternalizzati.

3. In multi-processo, la cache locale del worker poteva restare con un `workLock=order.create` anche se il repository MySQL `app_table_work_locks` era vuoto.
   - Fix: `orders/create` e `orders/cancel` leggono i lock esterni freschi con `refreshExternalizedTableLocks: true`.
   - Fix: dopo `assertActiveTableWorkLock`, create/cancel puliscono il mirror locale del lock se il fast-path lock e' attivo.

## File modificati

- `backend/server.js`
- `backend/tests/tables-locks.e2e.test.mjs`
- `backend/tests/route-policy-architecture.test.mjs`

## Test locali

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/tables-locks.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-name-pattern "order posSettings fast-path" backend/tests/route-policy-architecture.test.mjs
```

Esito:

- `tables-locks.e2e`: 7/7 pass
- `route-policy` mirato: 1/1 pass

## Test target Raspberry

Servizi riavviati:

- `cassav4-backend`
- `cassav4-api-worker@5283`
- `cassav4-api-worker@5284`

Guardie I/O reale:

- `PRINTING_ENABLED=0`
- log fiscale: `I/O reale disabilitato per test`
- worker stampa/fiscale/scheduler disattivati sui processi api-worker

Canary singolo post-fix:

- create role: `api-worker`
- sync role: `api-worker`
- cleanup role: `api-worker`
- esito: PASS

Batch finale:

```bash
ORDER_E2E_BATCH_RUN_ID=order_worker_batch_p3_22_lockfix_v3_12x_20260708
ORDER_E2E_BATCH_ITERATIONS=12
ORDER_E2E_BATCH_CONCURRENCY=1
```

Esito:

- pass: 12/12
- create p95: 684.91 ms
- sync p95: 594.43 ms
- cleanup p95: 210.21 ms
- route create/sync/cleanup: `api-worker`

Report target:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-order_worker_batch_p3_22_lockfix_v3_12x_20260708`

## Stato

Gate P3.22 verde per batch e2e sequenziale 12x.

Prossimo step consigliato: aumentare il canary da 12x sequenziale a un profilo piu' vicino al carico P3, con concorrenza controllata e verifica che il p95 resti stabile senza saturare il singolo worker.
