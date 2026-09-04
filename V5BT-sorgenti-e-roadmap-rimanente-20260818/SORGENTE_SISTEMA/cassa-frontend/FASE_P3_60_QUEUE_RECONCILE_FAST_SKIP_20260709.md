# FASE P3.60 - Queue Reconcile Fast Skip

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo I/O reale: stampa/fiscale/cassa automatica disattivati per test

## Obiettivo

Dopo P3.59 il collo rimasto in `orders/sync` era `queueReconcile`, circa 92-94 ms medi per worker. Il canary standard sincronizza l'ordine verso `prep`; in quel caso la lane e' gia occupata dall'ordine appena entrato in preparazione, quindi la riconciliazione globale della coda non deve promuovere altri ordini.

## Implementazione

- `backend/server.js`
  - aggiunto `ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP`.
  - `orders/sync` salta `reconcileIntegrationPreparationQueue()` quando:
    - non ci sono demotion di selezione, e
    - il piano preparazione e' un fast no-op non `waiting`, oppure
    - il piano indica `entersPreparation === true`.
  - lo stage `queueReconcile` resta misurato anche sullo skip.
- `backend/modules/runtime-metrics.js`
  - aggiunto counter `orderSyncQueueReconcileFastSkips`.
- `deploy/systemd/50-p3-orders-write-primary.conf`
  - aggiunto `BACKEND_ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP=1`.

Rollback:

```ini
Environment=BACKEND_ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP=0
```

## Test

Eseguiti sul Raspberry come utente `cassav4`:

```bash
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --check backend/modules/runtime-metrics.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
/usr/local/bin/node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs
```

Risultati:

- `route-policy-architecture.test.mjs`: 110/110 PASS
- `runtime-metrics.test.mjs`: 6/6 PASS
- `server.js`: 38.798 righe, budget M5 rispettato

## Canary 50

Run ufficiale con counter: `p3_60c_queue_reconcile_skip_counter_c1_50_20260709`

| Metrica | P3.59 | P3.60c | Delta |
| --- | ---: | ---: | ---: |
| OK | 50/50 | 50/50 | stabile |
| create p95 | 945.38 ms | 971.39 ms | +2.75% |
| sync p95 | 320.88 ms | 266.46 ms | -16.96% |
| readback p95 | 415.43 ms | 528.15 ms | +27.13% |
| cleanup p95 | 780.72 ms | 465.77 ms | -40.34% |

Best observed nello stesso step, prima dell'aggiunta del counter:

- Run `p3_60b_queue_reconcile_enter_prep_skip_c1_50_20260709`
- `sync p95`: 190.11 ms
- `sync avg`: 77.34 ms

## Metriche Runtime

Worker collection: 2/2 raccolti, 0 errori.

Skip:

| Worker | Skip |
| --- | ---: |
| 5283 | 25 |
| 5284 | 25 |
| Totale | 50 |

`queueReconcile`:

| Worker | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: |
| 5283 | 0.04 ms | 1 ms | 1 ms |
| 5284 | 0.00 ms | 1 ms | 0 ms |

Confronto P3.59: `queueReconcile` era circa 92-94 ms medi con p95 bucket 250 ms. Il costo e' stato quindi rimosso dal path caldo del canary standard.

Altri stage:

| Stage | Worker 5283 avg | Worker 5284 avg | Nota |
| --- | ---: | ---: | --- |
| `relationalSnapshotRead` | 3.48 ms | 5.00 ms | stabile |
| `preparationPlan` | 0.08 ms | 0.28 ms | stabile |
| `realtimeTableSnapshot` | 0.00 ms | 0.00 ms | stabile |
| `financialSync` | 10.60 ms | 0.32 ms | un outlier da 259 ms su worker 5283 |

## Note

Nei log post-canary compare un warning non bloccante: `[redis] cache namespace bump: Redis command timeout`. Il run resta PASS e lo stato finale e' coerente, ma il prossimo step dovrebbe guardare i timeout Redis/cache sotto burst.

## Artefatti

- `reports/p3_60_queue_reconcile_fast_skip_20260709/final_counter/order-worker-sync-e2e-batch-p3_60c_queue_reconcile_skip_counter_c1_50_20260709/REPORT.md`
- `reports/p3_60_queue_reconcile_fast_skip_20260709/final_counter/order-worker-sync-e2e-batch-p3_60c_queue_reconcile_skip_counter_c1_50_20260709/result.json`
- `reports/p3_60_queue_reconcile_fast_skip_20260709/final_counter/runtime-metrics.json`
- `reports/p3_60_queue_reconcile_fast_skip_20260709/runtime_metrics_summary.json`
- `reports/p3_60_queue_reconcile_fast_skip_20260709/post_canary_recent_warnings.txt`

## Prossimo Step

P3.61 consigliato: ridurre la varianza residua fuori dal path `queueReconcile`. I candidati attuali sono:

- timeout Redis/cache namespace bump durante burst;
- outlier `financialSync` su worker 5283;
- readback p95/p99 piu variabile del baseline.
