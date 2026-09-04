# Fase P3.42 - Indexed order lookup per merge scoped

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Run: `p3_42_order_lookup_index_c1_50_20260709`

## Obiettivo

Ridurre la CPU dei worker emersa nel profilo P3.40:

- `mergeIntegrationOrderWorkflowScopedOrders()`;
- `findIntegrationOrderSnapshotIndex()`;
- `findIntegrationOrderIndexByLookup()`.

Il problema era il merge scoped O(n*m): ogni ordine scoped faceva una ricerca
lineare nel base snapshot.

## Modifica

Introdotto un indice lookup temporaneo sullo snapshot ordini:

- `buildIntegrationOrderLookupIndex(orders)` in `order-lookup.domain.js`;
- `findIntegrationOrderIndexByLookup(orders, value, { lookupIndex })`;
- `mergeIntegrationOrderWorkflowScopedOrders()` costruisce l'indice una sola volta
  e lo riusa per tutti gli ordini scoped;
- `orders/sync` passa `buildIntegrationOrderLookupIndex` al merge scoped.

La semantica resta coerente con il vecchio `findIndex`: se piu' alias possono
matchare, vince sempre l'ordine che compariva prima nello snapshot.

File modificati:

- `backend/modules/integration/order-lookup.domain.js`
- `backend/modules/orders/order-preparation-queue.js`
- `backend/server.js`
- `backend/tests/integration-order-lookup-domain.test.mjs`
- `backend/tests/order-preparation-queue.test.mjs`

## Verifica

Eseguito sul Raspberry:

```bash
/usr/local/bin/node --check backend/modules/integration/order-lookup.domain.js
/usr/local/bin/node --check backend/modules/orders/order-preparation-queue.js
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --test --test-concurrency=1 \
  backend/tests/integration-order-lookup-domain.test.mjs \
  backend/tests/order-preparation-queue.test.mjs \
  backend/tests/route-policy-architecture.test.mjs
```

Esito: 129/129 PASS.

Canary 50:

| Metrica | P3.41 | P3.42 |
| --- | ---: | ---: |
| Esito | PASS | PASS |
| OK | 50/50 | 50/50 |
| Durata | 139276.43 ms | 118418.30 ms |
| create p95 | 678.42 ms | 729.39 ms |
| sync p95 | 1188.82 ms | 948.53 ms |
| readback p95 | 311.40 ms | 311.73 ms |
| cleanup p95 | 253.92 ms | 228.39 ms |

Il miglioramento specifico su `sync p95` e' circa `-20.2%`.

Runtime metrics P3.42:

| Contatore | Valore |
| --- | ---: |
| `writeDb` | 0 |
| `readDb` | 621 |
| `eventOutboxPublishRuns` | 131 |
| `eventOutboxPublished` | 273 |
| `eventOutboxPublishFailed` | 0 |
| `eventOutboxBacklogMetricRefreshes` | 29 |
| `eventOutboxBacklogMetricSkips` | 545 |
| `mqttPublishQueued` / `mqttPublishConfirmed` | 273 / 273 |
| `authSessionFastWrites` / fallback | 105 / 0 |
| `stationStatePresenceFastWrites` / fallback | 4 / 0 |
| `ordersAsyncFlushBatches` | 99 |
| `ordersAsyncFlushRetries` | 0 |
| `ordersAsyncFlushBackpressureSync` | 0 |

## Esito

Il merge scoped non riscansiona piu' lo snapshot base per ogni ordine scoped.
Il canary resta verde e il path sync migliora sensibilmente. Il `create p95`
oscilla leggermente verso l'alto, ma la patch non tocca il path create; il
prossimo collo indicato dal profilo resta la ricostruzione completa di
`buildIntegrationLayoutSnapshot()` / `findIntegrationLayoutTableSnapshot()`.

## Prossimo step consigliato

P3.43: evitare la ricostruzione completa del layout quando serve una sola
table. Il profilo P3.40 mostrava circa 12s CPU combinati per worker su:

- `buildIntegrationLayoutSnapshot()`;
- `findIntegrationLayoutTableSnapshot()`;
- `buildIntegrationTableLiveStats()`.

## Artifact

- Canary report: `reports/p3_42_order_lookup_index_20260709/cassav4-p3-42-export/canary/REPORT.md`
- Canary result JSON: `reports/p3_42_order_lookup_index_20260709/cassav4-p3-42-export/canary/result.json`
- Runtime metrics: `reports/p3_42_order_lookup_index_20260709/cassav4-p3-42-export/runtime-metrics.json`
- Export compresso: `reports/p3_42_order_lookup_index_20260709/cassav4-p3-42-export.tgz`
