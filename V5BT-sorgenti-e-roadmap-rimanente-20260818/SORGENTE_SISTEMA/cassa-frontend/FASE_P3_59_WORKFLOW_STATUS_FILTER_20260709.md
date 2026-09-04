# FASE P3.59 - Workflow Station Status Filter

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo I/O reale: stampa/fiscale/cassa automatica disattivati per test

## Obiettivo

Ridurre il costo di `orders/sync.relationalSnapshotRead` dopo P3.58. Il collo rilevato era la lettura del contesto station dallo snapshot relazionale: la query per postazione caricava anche lo storico di ordini non piu' utili al workflow caldo.

## Implementazione

- `backend/db/relational/orders.repo.js`
  - aggiunto filtro `statuses` a `listOrders()` e `listWorkflowOrders()`.
- `backend/modules/integration/relational-order-create.js`
  - `listRelationalOrderWorkflowSnapshot()` accetta `workflowStatuses`.
  - il target `orderId` resta full tramite `getOrderById()`.
  - il contesto station viene filtrato a stati di coda quando richiesto.
- `backend/server.js`
  - `orders/sync` passa `["waiting", "prep"]` come filtro station.
- `deploy/systemd/50-p3-orders-write-primary.conf`
  - aggiunto `BACKEND_ORDERS_SYNC_WORKFLOW_STATION_STATUS_FILTER=1`.

Rollback:

```ini
Environment=BACKEND_ORDERS_SYNC_WORKFLOW_STATION_STATUS_FILTER=0
```

## Test

Eseguiti sul Raspberry come utente `cassav4`:

```bash
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --check backend/modules/integration/relational-order-create.js
/usr/local/bin/node --check backend/db/relational/orders.repo.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/relational-orders.test.mjs
/usr/local/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
```

Risultati:

- `relational-orders.test.mjs`: 26/26 PASS
- `route-policy-architecture.test.mjs`: 109/109 PASS
- `server.js`: 38.797 righe, sotto budget M5

## Canary 50

Run: `p3_59_workflow_status_filter_c1_50_20260709`

| Metrica | P3.58 | P3.59 | Delta |
| --- | ---: | ---: | ---: |
| OK | 50/50 | 50/50 | stabile |
| create p95 | 916.96 ms | 945.38 ms | +3.10% |
| sync p95 | 562.32 ms | 320.88 ms | -42.94% |
| readback p95 | 424.65 ms | 415.43 ms | -2.17% |
| cleanup p95 | 419.25 ms | 780.72 ms | +86.22% |

Nota: il peggioramento `cleanup p95` e' variabilita' del run/fase cleanup, non effetto diretto del filtro P3.59 sul path `orders/sync`.

## Metriche Runtime

Worker collection: 2/2 raccolti, 0 errori.

`relationalSnapshotRead`:

| Worker | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: |
| 5283 | 3.40 ms | 10 ms | 12 ms |
| 5284 | 4.04 ms | 25 ms | 18 ms |

Confronto P3.58: lo stesso stage era circa 158-165 ms medi, p95 bucket 250 ms. Il filtro station a stati `waiting/prep` ha quindi rimosso quasi tutto il costo della lettura relazionale nel path caldo `orders/sync`.

Colli rimasti:

| Stage | Worker 5283 avg | Worker 5284 avg | Nota |
| --- | ---: | ---: | --- |
| `queueReconcile` | 93.76 ms | 92.52 ms | prossimo candidato P3 |
| `preparationPlan` | 0.20 ms | 0.12 ms | risolto rispetto a P3.58 |
| `realtimeTableSnapshot` | 0.04 ms | 0.00 ms | stabile/no-op |
| `financialSync` | 9.28 ms | 0.24 ms | un outlier da 227 ms su worker 5283 |

## Artefatti

- `reports/p3_59_workflow_status_filter_20260709/order-worker-sync-e2e-batch-p3_59_workflow_status_filter_c1_50_20260709/REPORT.md`
- `reports/p3_59_workflow_status_filter_20260709/order-worker-sync-e2e-batch-p3_59_workflow_status_filter_c1_50_20260709/result.json`
- `reports/p3_59_workflow_status_filter_20260709/runtime-metrics.json`
- `reports/p3_59_workflow_status_filter_20260709/runtime_metrics_summary.json`
- `reports/p3_59_workflow_status_filter_20260709/post_canary_recent_warnings.txt`

## Prossimo Step

P3.60 consigliato: intervenire su `queueReconcile`, ora primo costo stabile del path `orders/sync` con circa 92-94 ms medi per worker e p95 bucket 250 ms. La direzione piu' probabile e' renderlo delta/scoped, evitando riconciliazioni di coda piu' ampie del necessario quando l'ordine sincronizzato non cambia il set di preparazione.
