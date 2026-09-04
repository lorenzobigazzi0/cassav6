# Fase P3.48 - riuso snapshot tavolo da financial sync

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo sicurezza: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

Ridurre il collo P3.47 `orderSyncInternal:realtimeTableSnapshot`, che pesava circa 232-255 ms medi per sync. Il blocco ricalcolava snapshot tavolo, live stats e sessioni subito dopo `financialSync`, che aveva gia calcolato gli stessi dati per lo stesso tavolo target.

## Modifica

- `syncPosTableFinancialsFromIntegrationOrders()` ora costruisce `tableSnapshotsById` per i tavoli target, usando `tableFinancialPlan.nextTable` e i `liveStats` gia calcolati.
- `handleIntegrationOrderSync()` usa `financialSync.tableSnapshotsById.get(tableId)` come prima scelta.
- `findIntegrationLayoutTableSnapshot()` rimane fallback per compatibilita.
- Aggiunto guard statico P3.48 in `route-policy-architecture.test.mjs`.

Budget `server.js`: 38.799 righe, invariato sotto M5.

## Verifiche

Locale:

- `node --check backend/server.js`: PASS
- `route-policy-architecture`: 98/98 PASS
- `runtime-metrics`: 5/5 PASS

Raspberry:

- `server.js`: 38.799 righe
- `route-policy-architecture`: 98/98 PASS
- `runtime-metrics`: 5/5 PASS
- Servizi attivi: owner, worker 5283/5284, realtime, frontend, batteria.
- Env sicurezza confermate su owner e worker.

## Canary

Run: `p3_48_reuse_table_snapshot_c1_50_20260709`

| Metrica | P3.47 | P3.48 | Delta |
| --- | ---: | ---: | ---: |
| Esito | PASS 50/50 | PASS 50/50 | invariato |
| create p95 | 841.04 ms | 818.06 ms | -2.7% |
| sync p95 | 991.70 ms | 738.95 ms | -25.5% |
| readback p95 | 309.48 ms | 324.21 ms | +4.8% |
| cleanup p95 | 343.24 ms | 403.37 ms | +17.5% |

Durata batch: 131.083 s.

## Metriche interne worker

| Worker | Segmento | P3.47 avg | P3.48 avg | Lettura |
| --- | --- | ---: | ---: | --- |
| 5283 | `realtimeTableSnapshot` | 255.20 ms | 0.00 ms | eliminato dal path |
| 5284 | `realtimeTableSnapshot` | 232.44 ms | 0.04 ms | eliminato dal path |
| 5283 | `applyPlanQueue` | 197.32 ms | 210.44 ms | resta collo |
| 5284 | `applyPlanQueue` | 188.04 ms | 203.88 ms | resta collo |
| 5283 | `financialSync` | 182.40 ms | 192.32 ms | resta collo |
| 5284 | `financialSync` | 182.88 ms | 198.12 ms | resta collo |
| 5283 | `relationalSnapshotRead` | 140.24 ms | 141.68 ms | stabile |
| 5284 | `relationalSnapshotRead` | 140.60 ms | 126.04 ms | stabile |
| 5283 | `appStateWrite` | 0.32 ms | 0.20 ms | non collo |
| 5284 | `appStateWrite` | 0.16 ms | 0.12 ms | non collo |

## Lettura

P3.48 e' un miglioramento reale: il blocco realtime snapshot e' stato tolto dal percorso caldo e `sync p95` e' sceso di circa 253 ms. Il gate sub-500 ms resta aperto: i due blocchi dominanti sono ora:

1. `applyPlanQueue`, circa 204-210 ms avg.
2. `financialSync`, circa 192-198 ms avg.

`relationalSnapshotRead` resta circa 126-142 ms avg e puo diventare il terzo bersaglio dopo i primi due.

## Prossimo step consigliato

P3.49: spezzare `applyPlanQueue` in metriche interne e ridurre il costo:

- `buildIntegrationOrderWorkflowApplyPlan`
- `mergeIntegrationOrderWorkflowScopedOrders`
- `reconcileIntegrationPreparationQueue`

Se il peso principale e' il merge scoped orders, usare un replace puntuale per ID/lookup invece di ricostruire la lista scoped.

## Evidenze

- `reports/p3_48_reuse_table_snapshot_20260709/canary/REPORT.md`
- `reports/p3_48_reuse_table_snapshot_20260709/canary/result.json`
- `reports/p3_48_reuse_table_snapshot_20260709/p3-48-all-runtime-metrics.json`
- `reports/p3_48_reuse_table_snapshot_20260709/p3-48-worker-5283-runtime-metrics.json`
- `reports/p3_48_reuse_table_snapshot_20260709/p3-48-worker-5284-runtime-metrics.json`
- `reports/p3_48_reuse_table_snapshot_20260709/p3-48-order-sync-internal-summary.tsv`
- `reports/p3_48_reuse_table_snapshot_20260709/p3-48-services.txt`
