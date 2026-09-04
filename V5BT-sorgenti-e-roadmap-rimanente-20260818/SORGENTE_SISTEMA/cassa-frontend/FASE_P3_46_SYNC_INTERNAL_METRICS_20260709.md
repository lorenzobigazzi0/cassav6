# Fase P3.46 - Metriche interne orders/sync

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Run: `p3_46_sync_internal_metrics_c1_50_20260709`

## Obiettivo

P3.45 ha chiuso un full-scan nel financial sync, ma non ha migliorato il p95 di
`orders/sync`. P3.46 non cambia il comportamento applicativo: aggiunge metriche
interne a `handleIntegrationOrderSync()` per capire dove si concentra il costo.

## Modifica

Sono stati aggiunti 5 segmenti `runtimeMetrics.recordOperation()` con prefisso
`orderSyncInternal`:

- `workflowApplyAudit`
- `relationalWrite`
- `financialSync`
- `appStateWrite`
- `realtimeResponse`

Le label `orderSyncInternal:*` sono pinned nello snapshot runtime, quindi non
vengono tagliate dal limite top operations.

File modificati:

- `backend/server.js`
- `backend/modules/runtime-metrics.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/runtime-metrics.test.mjs`

Budget `server.js`: `38.799` righe, margine M5 ancora valido.

## Verifica

Locale:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs
```

Esito:

- route-policy: 97/97 PASS
- runtime-metrics: 5/5 PASS

Raspberry:

```bash
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --check backend/modules/runtime-metrics.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/runtime-metrics.test.mjs
```

Esito: 102/102 PASS.

Servizi dopo restart: backend owner, worker 5283, worker 5284, realtime,
frontend e battery tutti `active`.

Safety I/O confermata:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

## Canary 50

| Metrica | P3.45 finale | P3.46 |
| --- | ---: | ---: |
| Esito | PASS | PASS |
| OK | 50/50 | 50/50 |
| Durata | 125448.43 ms | 133802.12 ms |
| create p95 | 713.22 ms | 835.87 ms |
| sync p95 | 928.36 ms | 1020.36 ms |
| readback p95 | 290.55 ms | 330.52 ms |
| cleanup p95 | 245.84 ms | 308.47 ms |

P3.46 aggiunge osservabilita' e non e' atteso come ottimizzazione. Il canary
resta verde, ma la latenza resta sopra gate.

## Segmenti interni worker

Le metriche interne vivono sui worker API, non sull'owner. Per leggerle e' stato
necessario interrogare direttamente `5283` e `5284` con token owner piu'
`X-User-Id`.

| Segmento | Worker 5283 avg/max | Worker 5284 avg/max | Lettura |
| --- | ---: | ---: | --- |
| `workflowApplyAudit` | 309.00 / 507 ms | 293.36 / 374 ms | collo principale |
| `appStateWrite` | 250.84 / 418 ms | 232.64 / 276 ms | secondo collo |
| `financialSync` | 166.20 / 266 ms | 149.48 / 205 ms | terzo collo |
| `relationalWrite` | 23.96 / 564 ms | 1.84 / 8 ms | basso, con un outlier |
| `realtimeResponse` | 3.56 / 58 ms | 19.60 / 254 ms | basso, con outlier |

Metriche gia' esistenti utili:

| Segmento | Worker 5283 avg | Worker 5284 avg |
| --- | ---: | ---: |
| `orders.sync.relationalSnapshotRead` | 120.16 ms | 119.12 ms |
| `orders.sync.relationalFinancialSnapshotRead` | 35.84 ms | 32.64 ms |
| `orders.sync.appStateWrite.deferred` | 0.08 ms | 0.08 ms |

Interpretazione: il relazionale puro non e' il collo principale. La write
deferred e' praticamente immediata; i ~240 ms etichettati `appStateWrite` sono
nel lavoro fatto prima/durante la preparazione della chiamata, non nel flush
async in se'.

## Esito

P3.46 chiude la fase di misurazione interna. Il collo misurato e':

1. `workflowApplyAudit`, che include anche `orders.sync.relationalSnapshotRead`
   (~120 ms medi);
2. preparazione attorno a `appStateWrite`, non il defer;
3. `financialSync`, ancora rilevante ma non dominante.

## Prossimo step consigliato

P3.47: separare e ridurre i due blocchi principali:

- spacchettare `workflowApplyAudit` in `relationalSnapshotRead`,
  `workflowMergePlan`, `auditBuild`, `queueReconcile`;
- spacchettare `appStateWrite` in `realtimeTableSnapshot`,
  `readyNotificationPublish`, `auditEventIdsCollect`, `deferCall`.

Questo dira' se il primo fix vero deve colpire la snapshot relazionale iniziale,
il merge/preparation plan, la raccolta audit ids o la snapshot tavolo usata per
payload realtime.

## Artifact

- Canary report: `reports/p3_46_sync_internal_metrics_20260709/REPORT.md`
- Canary result JSON: `reports/p3_46_sync_internal_metrics_20260709/result.json`
- Runtime metrics owner/proxy: `reports/p3_46_sync_internal_metrics_20260709/p3-46-runtime-metrics.json`
- Runtime metrics worker 5283: `reports/p3_46_sync_internal_metrics_20260709/p3-46-worker-5283-runtime-metrics.json`
- Runtime metrics worker 5284: `reports/p3_46_sync_internal_metrics_20260709/p3-46-worker-5284-runtime-metrics.json`
- Export compresso completo: `reports/p3_46_sync_internal_metrics_20260709/cassav4-p3-46-export-with-workers.tgz`
