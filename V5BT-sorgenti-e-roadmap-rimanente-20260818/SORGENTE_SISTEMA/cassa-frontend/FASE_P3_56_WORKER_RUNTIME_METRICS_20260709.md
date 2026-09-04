# Fase P3.56 - Worker Runtime Metrics Aggregation

Data: 2026-07-09  
Target: Raspberry `192.168.0.67`  
Profilo test: stampa, fiscale e cassa reale disattivati.

## Obiettivo

Rendere osservabili dal monitor owner le metriche runtime dei processi `api-worker`.
Lo step precedente P3.55 aveva confermato il canary end-to-end, ma il monitor
esponeva solo il processo owner: i costi reali di `orders/create` e
`orders/sync`, instradati sui worker, restavano invisibili.

## Implementazione

- Aggiunta route interna:
  - `GET /api/internal/monitor/runtime-metrics`
  - service token `integration`
  - nessun fan-out ricorsivo sui worker.
- La route interna e' stata ammessa nella policy multiprocesso dei worker.
- Il monitor admin `GET /api/monitor/runtime-metrics` aggrega ora:
  - snapshot locale owner;
  - `workerCollection`;
  - array `workers[]` con snapshot runtime dei peer.
- Il discovery dei peer usa:
  - `BACKEND_RUNTIME_METRICS_PEER_URLS`;
  - fallback `BACKEND_API_WORKER_ORIGIN`.
- Sul Raspberry e' stato aggiunto il drop-in owner:

```ini
[Service]
Environment=BACKEND_RUNTIME_METRICS_PEER_URLS=http://127.0.0.1:5283,http://127.0.0.1:5284
Environment=BACKEND_RUNTIME_METRICS_PEER_TIMEOUT_MS=750
```

Backup remoto dei file toccati:

`/opt/cassav4/backups/p3-56-runtime-metrics-20260709-132047`

## Rollback

Rimuovere il drop-in:

```bash
sudo rm /etc/systemd/system/cassav4-backend.service.d/70-runtime-metrics-workers.conf
sudo systemctl daemon-reload
sudo systemctl restart cassav4-backend.service
```

Il codice resta compatibile anche senza peer configurati: `workerCollection.enabled`
torna `false` e `workers` torna vuoto.

## Test

Sul Raspberry:

- `node --check backend/server.js` -> OK
- `node --check backend/modules/status/status.handlers.js` -> OK
- `node --check backend/modules/status/status.routes.js` -> OK
- `node --check backend/core/process-topology.js` -> OK
- `node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs` -> 6/6
- `node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs` -> 106/106

Nota: il runtime Node non e' disponibile nel PATH del workspace locale; i check
sono stati eseguiti sul target reale, con lo stesso Node dei servizi systemd.

## Deploy

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`

Health post restart:

- `5281` owner -> OK
- `5282` realtime -> OK
- `5283` worker -> OK
- `5284` worker -> OK
- `5280` HTTPS proxy -> OK

## Canary 50

Report remoto:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_56_worker_metrics_c1_50_20260709`

Risultato:

| Run | OK | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| P3.56 | 50/50 | 862.98 ms | 782.59 ms | 383.80 ms | 341.17 ms |

Routing:

- `create`: 50/50 su `api-worker`
- `sync`: 50/50 su `api-worker`
- `cleanup`: 50/50 su `api-worker`
- `readback`: 50/50 su `api-worker`

Confronto P3.55:

| Step | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: |
| P3.55 | 845.69 ms | 711.11 ms | 402.16 ms | 548.74 ms |
| P3.56 | 862.98 ms | 782.59 ms | 383.80 ms | 341.17 ms |

## Metriche Aggregate

Monitor owner dopo canary:

- `workerCollection`: enabled `true`, expected `2`, collected `2`, failed `0`
- `ordersAsyncFlushEnqueued`: `102`
- `ordersAsyncFlushRetries`: `0`
- `ordersAsyncFlushBackpressureSync`: `0`
- `ordersAsyncFlushPendingDepth`: `0`
- `eventOutboxUnpublished`: `0`
- `mysqlPoolPendingAcquires`: `0`

Worker `5283`:

- richieste: `104`
- flush inoltrati all'owner: `51`
- fallback flush: `0`
- `orderSyncInternal:financialSync`: avg `208.04 ms`, p95 bucket `500 ms`
- `orderSyncInternal:relationalSnapshotRead`: avg `161.68 ms`, p95 bucket `250 ms`
- `orderSyncInternal:preparationPlan`: avg `98.16 ms`, p95 bucket `250 ms`
- `orderSyncInternal:queueReconcile`: avg `93.64 ms`, p95 bucket `250 ms`

Worker `5284`:

- richieste: `127`
- flush inoltrati all'owner: `51`
- fallback flush: `0`
- `orderSyncInternal:financialSync`: avg `189.64 ms`, p95 bucket `250 ms`
- `orderSyncInternal:relationalSnapshotRead`: avg `144.76 ms`, p95 bucket `250 ms`
- `orderSyncInternal:preparationPlan`: avg `87.40 ms`, p95 bucket `250 ms`
- `orderSyncInternal:queueReconcile`: avg `89.36 ms`, p95 bucket `250 ms`

## Valutazione

Lo step chiude la lacuna di osservabilita': ora il monitor owner vede i costi
effettivi dei worker senza aprire endpoint admin sui processi worker.

Il canary resta verde, le code sono drenate e non ci sono fallback del flush
remoto. Il prossimo collo da attaccare non e' piu' il fan-out del monitor, ma il
costo interno di `orders/sync`, in ordine di priorita':

1. `financialSync`
2. `relationalSnapshotRead`
3. `preparationPlan`
4. `queueReconcile`

Nota operativa: dopo il restart e' comparso un warning non bloccante di
startup-reconcile owner:

`Record has changed since last read in table 'app_state_domain_records_order_station_index'`

Health e canary sono comunque passati. Va tenuto come candidato per un futuro
step di hardening del reconcile in presenza di piu' processi in avvio.

## Artefatti

- `reports/p3_56_worker_runtime_metrics_20260709/canary_result.json`
- `reports/p3_56_worker_runtime_metrics_20260709/p3-56-canary-report.tgz`
- `reports/p3_56_worker_runtime_metrics_20260709/runtime_metrics_aggregated.json`
- `reports/p3_56_worker_runtime_metrics_20260709/runtime_metrics_summary.json`
- `reports/p3_56_worker_runtime_metrics_20260709/p3-56-services.txt`
