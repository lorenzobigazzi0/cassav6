# Fase P3.47 - orders/sync internal stage split

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo sicurezza: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

Separare la metrica P3.46 `orderSyncInternal` nei segmenti reali del percorso `/api/integration/orders/sync`, senza cambiare comportamento funzionale. Lo scopo e capire quali blocchi saturano CPU/event loop nel profilo multiprocesso.

## Modifiche

- Aggiunti marker runtime in `backend/server.js`:
  - `relationalSnapshotRead`
  - `mergeSanitizeLock`
  - `preparationPlan`
  - `applyPlanQueue`
  - `workflowApplyAudit`
  - `relationalWrite`
  - `financialSync`
  - `realtimeTableSnapshot`
  - `readyNotificationPublish`
  - `auditEventIdsCollect`
  - `appStateWrite`
  - `realtimeResponse`
- Spostata la raccolta `collectAuditEventIdsSince` fuori dagli argomenti del write/defer, cosi `appStateWrite` misura la chiamata effettiva a `writeIntegrationOrderSyncDb`.
- Aggiornato il test architetturale P3.47 per bloccare i marker e la raccolta audit IDs esplicita.

Budget `server.js`: 38.799 righe, invariato e sotto il limite M5.

## Verifiche locali

- `node --check backend/server.js`: PASS
- `node --check backend/modules/runtime-metrics.js`: PASS
- `backend/tests/route-policy-architecture.test.mjs`: 97/97 PASS
- `backend/tests/runtime-metrics.test.mjs`: 5/5 PASS

## Verifiche Raspberry

- Deploy allineato in `/opt/cassav4/current/cassa-frontend`
- Servizi attivi:
  - `cassav4-backend.service`
  - `cassav4-api-worker@5283.service`
  - `cassav4-api-worker@5284.service`
  - `cassav4-realtime.service`
  - `cassav4-frontend.service`
  - `cassav4-battery.service`
- Env sicurezza confermate su owner e worker.
- Test sul target:
  - `route-policy-architecture`: 97/97 PASS
  - `runtime-metrics`: 5/5 PASS

## Canary P3.47

Run: `p3_47_sync_stage_split_c1_50_20260709`

| Runs | OK | Failed | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 50 | 0 | 841.04 ms | 991.70 ms | 309.48 ms | 343.24 ms |

Durata totale: 139.639 s.

## Split worker

| Worker | Segmento | Count | Avg ms | Max ms | p95 bucket ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 5283 | `realtimeTableSnapshot` | 25 | 255.20 | 449 | 500 |
| 5283 | `applyPlanQueue` | 25 | 197.32 | 321 | 500 |
| 5283 | `financialSync` | 25 | 182.40 | 220 | 250 |
| 5283 | `relationalSnapshotRead` | 25 | 140.24 | 268 | 250 |
| 5283 | `relationalWrite` | 25 | 1.76 | 7 | 5 |
| 5283 | `appStateWrite` | 25 | 0.32 | 3 | 1 |
| 5284 | `realtimeTableSnapshot` | 25 | 232.44 | 314 | 500 |
| 5284 | `applyPlanQueue` | 25 | 188.04 | 285 | 250 |
| 5284 | `financialSync` | 25 | 182.88 | 273 | 500 |
| 5284 | `relationalSnapshotRead` | 25 | 140.60 | 214 | 250 |
| 5284 | `relationalWrite` | 25 | 8.64 | 175 | 10 |
| 5284 | `appStateWrite` | 25 | 0.16 | 1 | 1 |

Segmenti quasi nulli:

- `auditEventIdsCollect`: <= 0.04 ms avg
- `preparationPlan`: <= 0.08 ms avg
- `workflowApplyAudit`: <= 0.12 ms avg
- `readyNotificationPublish`: 0 ms avg
- `mergeSanitizeLock`: circa 1.3-1.6 ms avg
- `realtimeResponse`: 1.5-5.2 ms avg

## Lettura

P3.47 conferma che il collo non e piu `writeIntegrationOrderSyncDb`/mirror app-state: dopo lo split `appStateWrite` misura 0.16-0.32 ms avg. Il costo grosso rimane prima del defer:

1. `realtimeTableSnapshot`, circa 232-255 ms avg.
2. `applyPlanQueue`, circa 188-197 ms avg.
3. `financialSync`, circa 182-183 ms avg.
4. `relationalSnapshotRead`, circa 140 ms avg.

La scrittura relazionale resta bassa, salvo un outlier singolo su 5284.

## Prossimo step consigliato

P3.48 dovrebbe spezzare e/o ottimizzare i tre blocchi piu pesanti:

- `realtimeTableSnapshot`: verificare perche `findIntegrationLayoutTableSnapshot` resta costoso nonostante il target sia un solo tavolo.
- `applyPlanQueue`: separare apply plan, merge scoped orders e `reconcileIntegrationPreparationQueue`.
- `financialSync`: ridurre ulteriormente live stats/sessioni/layout residuali oppure cache target per tavolo.

Il gate P3 resta rosso sul target p95 < 500 ms, ma ora il profilo dice dove intervenire.

## Evidenze

- `reports/p3_47_sync_stage_split_20260709/canary/REPORT.md`
- `reports/p3_47_sync_stage_split_20260709/canary/result.json`
- `reports/p3_47_sync_stage_split_20260709/p3-47-all-runtime-metrics.json`
- `reports/p3_47_sync_stage_split_20260709/p3-47-worker-5283-runtime-metrics.json`
- `reports/p3_47_sync_stage_split_20260709/p3-47-worker-5284-runtime-metrics.json`
- `reports/p3_47_sync_stage_split_20260709/p3-47-order-sync-internal-summary.tsv`
- `reports/p3_47_sync_stage_split_20260709/p3-47-services.txt`
