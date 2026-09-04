# Fase P3.41 - Event outbox backlog metrics throttle

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Run: `p3_41_event_outbox_metrics_c1_50_20260708`

## Obiettivo

Ridurre la CPU dell'owner emersa nel profilo P3.40. Il profilo mostrava
`EventOutboxRepository.countSummary()` come costo self principale
sull'owner (`14.65s` CPU sampled), chiamato da `refreshBacklogMetrics()` a
ogni publish loop.

## Modifica

La query pesante di summary backlog non viene piu' eseguita a ogni giro:

- nuovo default `EVENT_OUTBOX_BACKLOG_METRICS_INTERVAL_MS=5000`;
- prima lettura sempre esatta;
- retention sempre esatta;
- publish ravvicinati aggiornano le gauge via delta cached;
- refresh troppo ravvicinati incrementano `eventOutboxBacklogMetricSkips`;
- refresh reali incrementano `eventOutboxBacklogMetricRefreshes`.

File modificati:

- `backend/modules/realtime-backbone/event-outbox.js`
- `backend/modules/runtime-metrics.js`
- `backend/server.js`
- `backend/tests/realtime-backbone.test.mjs`

## Verifica

Eseguito sul Raspberry:

```bash
/usr/local/bin/node --check backend/modules/realtime-backbone/event-outbox.js
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/realtime-backbone.test.mjs backend/tests/runtime-metrics.test.mjs
```

Esito: 15/15 PASS.

Canary 50:

| Metrica | Valore |
| --- | ---: |
| Esito | PASS |
| OK | 50/50 |
| Durata | 139276.43 ms |
| create p95 | 678.42 ms |
| sync p95 | 1188.82 ms |
| readback p95 | 311.40 ms |
| cleanup p95 | 253.92 ms |

Runtime metrics:

| Contatore | Valore |
| --- | ---: |
| `writeDb` | 0 |
| `readDb` | 625 |
| `eventOutboxPublishRuns` | 89 |
| `eventOutboxPublished` | 173 |
| `eventOutboxPublishFailed` | 0 |
| `eventOutboxBacklogMetricRefreshes` | 33 |
| `eventOutboxBacklogMetricSkips` | 628 |
| `mqttPublishQueued` / `mqttPublishConfirmed` | 173 / 173 |
| `authSessionFastWrites` / fallback | 105 / 0 |
| `stationStatePresenceFastWrites` / fallback | 4 / 0 |
| `ordersAsyncFlushBatches` | 101 |
| `ordersAsyncFlushRetries` | 0 |
| `ordersAsyncFlushBackpressureSync` | 0 |

## Esito

Il collo owner su backlog metrics e' stato ridotto senza spegnere le gauge.
Nel canary P3.41 sono stati evitati 628 refresh ravvicinati e sono rimasti
solo 33 refresh reali. Il path ordine resta write-primary/async-flush stabile:
nessun `writeDb`, nessun retry e nessuna backpressure.

Il p95 complessivo resta dominato dai worker (`handleIntegrationOrderSync`,
lookup ordini e snapshot tavolo). Prossimo step consigliato: indicizzare lo
snapshot ordini usato da `mergeIntegrationOrderWorkflowScopedOrders()` e
ridurre la ricostruzione completa di `buildIntegrationLayoutSnapshot()` quando
serve una singola table.

## Artifact

- Canary report: `reports/p3_41_event_outbox_metrics_20260708/cassav4-p3-41-export/canary/REPORT.md`
- Canary result JSON: `reports/p3_41_event_outbox_metrics_20260708/cassav4-p3-41-export/canary/result.json`
- Runtime metrics: `reports/p3_41_event_outbox_metrics_20260708/cassav4-p3-41-export/runtime-metrics.json`
- Export compresso: `reports/p3_41_event_outbox_metrics_20260708/cassav4-p3-41-export.tgz`
