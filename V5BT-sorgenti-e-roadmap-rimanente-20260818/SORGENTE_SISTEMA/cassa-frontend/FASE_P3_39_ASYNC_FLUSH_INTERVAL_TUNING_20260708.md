# Fase P3.39 - Async Flush Interval Tuning

Data: 2026-07-08
Target deploy: Raspberry 192.168.0.67
Root target: /opt/cassav4/current/cassa-frontend

## Obiettivo

Verificare se il p95 `sync` fosse ancora legato alla finestra fissa `orders.asyncFlush.queueWait`, dopo P3.38. Il profilo stabile precedente usava `ORDERS_ASYNC_FLUSH_INTERVAL_MS=500`.

## Modifiche finali mantenute

- `deploy/systemd/50-p3-orders-write-primary.conf` resta a `ORDERS_ASYNC_FLUSH_INTERVAL_MS=500`.
- Aggiunto guardrail architetturale:
  - test P3.39 in `backend/tests/route-policy-architecture.test.mjs`;
  - impedisce tuning cieco dell'intervallo finche non esiste uno scheduler adattivo o un canary migliore.

## Esperimenti eseguiti

### 100ms

- Configurazione provata su target: `ORDERS_ASYNC_FLUSH_INTERVAL_MS=100`.
- Canary: `p3_39_async_flush_100ms_c1_20_20260708`.
- Esito: PASS 20/20.
- Create p95: 854.91ms.
- Sync p95: 1151.21ms.
- Cleanup p95: 204.40ms.
- Readback p95: 331.55ms.
- Metriche:
  - `ordersAsyncFlushBatches`: 60.
  - `orders.asyncFlush.queueWait` avg: 132.93ms, p95 bucket: 250ms.
  - retry/backpressure: 0.

Conclusione: queueWait scende, ma il numero di flush cresce da 40 a 60 e il p95 utente non migliora.

### 250ms

- Configurazione provata su target: `ORDERS_ASYNC_FLUSH_INTERVAL_MS=250`.
- Canary: `p3_39_async_flush_250ms_c1_20_20260708`.
- Esito: PASS 20/20.
- Create p95: 742.66ms.
- Sync p95: 1163.96ms.
- Cleanup p95: 474.24ms.
- Readback p95: 317.93ms.
- Metriche:
  - `ordersAsyncFlushBatches`: 57.
  - `orders.asyncFlush.queueWait` avg: 261.07ms, p95 bucket: 500ms.
  - retry/backpressure: 0.

Conclusione: compromesso non efficace; il p95 sync peggiora e il cleanup ha piu rumore.

### Rollback stabile 500ms

- Configurazione finale ripristinata: `ORDERS_ASYNC_FLUSH_INTERVAL_MS=500`.
- Canary: `p3_39_restored_500ms_c1_20_20260708`.
- Esito: PASS 20/20.
- Create p95: 730.37ms.
- Sync p95: 1157.19ms.
- Cleanup p95: 241.28ms.
- Readback p95: 322.34ms.
- Metriche:
  - `ordersAsyncFlushBatches`: 40.
  - `orders.asyncFlush.queueWait` avg: 519ms, p95 bucket: 1000ms.
  - `orders.asyncFlush.mysqlLockWait` avg: 5.25ms, p95 bucket: 25ms.
  - retry/backpressure: 0.
  - `writeDb`: 0.
  - `writeDbFullStateFallback`: 0.

Conclusione: il 500ms mantiene piu coalescing e meno competizione. L'intervallo non e piu il collo principale del p95 utente.

## Test

Locale:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/process-topology.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/order-async-appstate-flush.test.mjs backend/tests/runtime-metrics.test.mjs
```

Esito:

- Architettura/topologia: 104/104 PASS.
- Queue/runtime: 13/13 PASS.
- `backend/server.js`: 38.775 righe.

Target:

- Health OK su 5281, 5283, 5284.
- Architettura/topologia: 104/104 PASS.
- Queue/runtime: 13/13 PASS prima del rollback finale.
- Dopo rollback: log startup conferma `flushInterval=500ms`.
- Unita fallite systemd: 0.
- Servizi attivi: backend, worker 5283, worker 5284, realtime, frontend, battery.

## Valutazione

P3.39 chiude l'ipotesi "basta abbassare il flush interval": sotto 500ms il queue wait migliora, ma il sistema perde coalescing, produce piu batch e non migliora il p95 utente. La configurazione finale resta quindi quella stabile a 500ms, con guardrail per evitare regressioni.

## Prossimo step consigliato

Passare da tuning statico a diagnosi CPU/handler:

1. Eseguire canary 50 con `--cpu-prof` su owner e almeno un worker.
2. Separare il tempo di foreground route da background async flush.
3. Attaccare il prossimo top cost misurato, invece di ritoccare ulteriormente il flush interval.
