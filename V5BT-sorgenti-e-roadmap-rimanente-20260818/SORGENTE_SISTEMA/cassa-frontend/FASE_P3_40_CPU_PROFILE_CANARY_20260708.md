# Fase P3.40 - CPU profile canary 50 device

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Run: `p3_40_cpu_prof_c1_50_20260708`

## Obiettivo

Verificare con `--cpu-prof` il collo di bottiglia rimasto dopo P3.37-P3.39. I flag di I/O reale sono rimasti disattivati durante il run:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

La profilazione e' stata applicata temporaneamente a:

- `cassav4-backend.service` (`api-owner:5281`)
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`

Profilazione rimossa a fine run. E' rimasto solo il drop-in di safety real-IO-off per i test sul Raspberry.

## Risultato canary

Canary: 50 iterazioni, concorrenza 1, postazioni simulate `BAR PRINCIPALE` e `CUCINA`.

| Metrica | Valore |
| --- | ---: |
| Esito | PASS |
| OK | 50/50 |
| Durata | 141546.52 ms |
| create p95 | 691.55 ms |
| sync p95 | 1140.13 ms |
| readback p95 | 330.63 ms |
| cleanup p95 | 593.73 ms |

Runtime metrics owner rilevanti:

| Contatore | Valore |
| --- | ---: |
| `writeDb` | 0 |
| `readDb` | 626 |
| `authSessionFastWrites` | 105 |
| `authSessionFastFallbacks` | 0 |
| `stationStatePresenceFastWrites` | 4 |
| `stationStatePresenceFastFallbacks` | 0 |
| `ordersAsyncFlushBatches` | 101 |
| `ordersAsyncFlushRetries` | 0 |
| `ordersAsyncFlushBackpressureSync` | 0 |
| `eventOutboxPublishRuns` | 116 |
| `eventOutboxPublished` | 250 |
| `mqttPublishQueued` / `mqttPublishConfirmed` | 250 / 250 |

## CPU profile

Profili salvati in `reports/p3_40_cpu_profile_20260708/cassav4-p3-40-export/profiles/`.

| Processo | PID profilo | App CPU sampled | Top evidenza |
| --- | ---: | ---: | --- |
| `api-owner:5281` | 120766 | 24.2 s | `countSummary()` outbox 14.65 s self |
| `api-worker:5283` | 120767 | 52.9 s | `handleIntegrationOrderSync()` 17.58 s inclusive |
| `api-worker:5284` | 120771 | 49.0 s | `handleIntegrationOrderSync()` 18.12 s inclusive |

Top owner:

- `backend/db/relational/realtime-backbone.repo.js:425 countSummary()` = 14.65 s self.
- `backend/modules/realtime-backbone/event-outbox.js:43 refreshBacklogMetrics()` = 14.69 s inclusive.
- `backend/modules/realtime-backbone/event-outbox.js:86 publishPending()` = 15.01 s inclusive.
- `backend/auth/password.js:40 verifyPin()` = 10.76 s inclusive, dovuto ai 103 login del canary.

Top worker:

- `backend/server.js:30453 handleIntegrationOrderSync()` = 17.6-18.1 s inclusive.
- `backend/server.js:28867 handleIntegrationOrderCreate()` = 10.6-11.1 s inclusive.
- `backend/modules/orders/order-preparation-queue.js:136 mergeIntegrationOrderWorkflowScopedOrders()` = 7.3-7.4 s inclusive.
- `backend/modules/orders/order-preparation-queue.js:46 findIntegrationOrderSnapshotIndex()` = 6.7-6.8 s inclusive.
- `backend/server.js:7113 buildIntegrationLayoutSnapshot()` / `7131 findIntegrationLayoutTableSnapshot()` = circa 12 s combinati per worker.
- `backend/modules/integration/order-lookup.domain.js:22 findIntegrationOrderIndexByLookup()` = 4.3-4.7 s inclusive.

## Conclusione

Il gate P3 resta limitato da CPU sincrona, non da write path. Il run conferma che i fast path gia' introdotti stanno funzionando:

- nessun `writeDb` full-state nel percorso owner;
- flush async senza retry e senza backpressure;
- sessioni e presenza postazioni su write fast.

Il prossimo miglioramento ad alto rapporto rischio/beneficio e' **throttling/caching dei backlog metrics dell'event outbox**: oggi `refreshBacklogMetrics()` fa un `COUNT/SUM/MIN` completo a ogni polling/publish run e costa circa 126 ms per run sul Raspberry. Questo e' indipendente dalla correttezza del publish: si puo' aggiornare la gauge a intervallo, su errore o dopo batch significativo, senza bloccare ogni giro.

Subito dopo conviene intervenire sui worker:

1. indicizzare per `orderId` lo snapshot usato da `mergeIntegrationOrderWorkflowScopedOrders()`;
2. evitare la ricostruzione completa di `buildIntegrationLayoutSnapshot()` quando serve una sola table;
3. ridurre i `cloneJson()` e `safeJsonParse()` ripetuti nel percorso create/sync.

## Artifact

- Canary report: `reports/p3_40_cpu_profile_20260708/cassav4-p3-40-export/canary/REPORT.md`
- Canary result JSON: `reports/p3_40_cpu_profile_20260708/cassav4-p3-40-export/canary/result.json`
- Runtime metrics: `reports/p3_40_cpu_profile_20260708/cassav4-p3-40-export/runtime-metrics.json`
- Profili CPU: `reports/p3_40_cpu_profile_20260708/cassav4-p3-40-export/profiles/*.cpuprofile`
- Export compresso: `reports/p3_40_cpu_profile_20260708/cassav4-p3-40-export.tgz`
