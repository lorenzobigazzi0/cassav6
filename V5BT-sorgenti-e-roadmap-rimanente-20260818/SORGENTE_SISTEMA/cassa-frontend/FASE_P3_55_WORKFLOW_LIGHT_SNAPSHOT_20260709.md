# Fase P3.55 - Workflow Light Snapshot

Data: 2026-07-09  
Target: Raspberry `192.168.0.67`  
Profilo test: stampa/fiscale/cassa reale disattivati.

## Obiettivo

Ridurre il costo della lettura relazionale usata da `/api/integration/orders/sync` per la sola macchina a stati workflow, senza cambiare i financial snapshot e senza perdere campi quando il flusso puo' demansionare altri ordini.

## Implementazione

- Aggiunta `OrdersRelationalRepository.listWorkflowOrders(filters)`.
- La nuova idratazione `#hydrateWorkflowOrder` conserva solo i campi necessari a:
  - stato workflow;
  - lane/postazione/operatore;
  - conteggio coda preparazione;
  - progressi minimi di `items` e `lineRoutes`.
- `listScopedRelationalOrders` mantiene sempre il target ordine full tramite `getOrderById`.
- Gli ordini di contesto station/table possono usare la vista light solo con `workflowLight: true`.
- `/orders/sync` abilita la vista light solo se:
  - `BACKEND_ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT !== "0"`;
  - il motivo workflow non e' in `INTEGRATION_PREPARATION_SELECTION_REASONS`.
- I financial snapshot restano full e non ricevono `workflowLight`.

Rollback:

```bash
BACKEND_ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT=0
systemctl restart cassav4-backend.service cassav4-api-worker@5283.service cassav4-api-worker@5284.service
```

## Test

Locali:

- `node --check backend/server.js`
- `node --check backend/db/relational/orders.repo.js`
- `node --check backend/modules/integration/relational-order-create.js`
- `node --test --test-concurrency=1 backend/tests/relational-orders.test.mjs` -> 25/25
- `node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs` -> 105/105
- `node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs` -> 5/5

Raspberry:

- `backend/tests/relational-orders.test.mjs` -> 25/25
- `backend/tests/route-policy-architecture.test.mjs` -> 105/105
- `backend/tests/runtime-metrics.test.mjs` -> 5/5

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`
- `cassav4-battery.service`

## Canary 50

Report remoto:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_55_workflow_light_c1_50_20260709`

Risultato:

| Run | OK | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| P3.55 | 50/50 | 845.69 ms | 711.11 ms | 402.16 ms | 548.74 ms |

Confronto ultimi step:

| Step | Create p95 | Sync p95 | Note |
| --- | ---: | ---: | --- |
| P3.53 | n.d. | 723.66 ms | batch station/table ids |
| P3.54 | 928.14 ms | 763.63 ms | split metriche readDb/auth/snapshot |
| P3.55 | 845.69 ms | 711.11 ms | workflow snapshot light |

Miglioramento P3.55 vs P3.54:

- `create p95`: -82.45 ms, circa -8.9%.
- `sync p95`: -52.52 ms, circa -6.9%.
- `readback p95`: -16.28 ms, circa -3.9%.

## Metriche operative

Owner metrics dopo canary:

- `ordersAsyncFlushEnqueued`: 104
- `ordersAsyncFlushRetries`: 0
- `ordersAsyncFlushBackpressureSync`: 0
- `ordersAsyncFlushPendingDepth`: 0
- `eventOutboxUnpublished`: 0
- `mqttConnected`: 1
- `mysqlPoolActiveConnections`: 0
- `mysqlPoolPendingAcquires`: 0
- `printSpoolClaimed`: 0
- `printerTimeouts`: 0

Nota: il canary ha instradato create/sync/cleanup/readback sugli `api-worker`. I worker bloccano login/monitor diretto per policy (`BACKEND_PROCESS_ROUTE_BLOCKED`), quindi il dettaglio `orderSyncInternal:*` processo-locale non e' stato esportato dal monitor. L'evidenza primaria di questo step e' quindi il canary end-to-end; le metriche owner confermano che async flush/outbox/code sono drenate.

## Valutazione

La modifica e' corretta e reversibile. Il miglioramento e' reale ma moderato: riduce allocazioni e payload idratato nella snapshot workflow, pero' il collo principale resta CPU/event-loop sugli handler e sulle fasi successive. Il prossimo step utile e' rendere osservabili le metriche worker dal monitor owner oppure dal canary, poi attaccare il costo rimasto su:

- `preparationPlan`;
- `financialSync`;
- fan-out realtime/outbox;
- costo login/sessioni sotto worker.

## Artefatti

- `reports/p3_55_workflow_light_snapshot_20260709/canary_REPORT.md`
- `reports/p3_55_workflow_light_snapshot_20260709/canary_result.json`
- `reports/p3_55_workflow_light_snapshot_20260709/runtime_metrics_owner_selected.json`
