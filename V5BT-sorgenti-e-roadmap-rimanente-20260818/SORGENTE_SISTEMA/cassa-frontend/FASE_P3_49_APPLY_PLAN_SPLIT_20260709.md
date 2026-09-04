# Fase P3.49 - split applyPlanQueue

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo sicurezza: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

P3.48 ha rimosso il collo `realtimeTableSnapshot`; il blocco residuo piu opaco era `applyPlanQueue`, circa 204-210 ms medi. P3.49 lo divide in sottostadi per capire dove intervenire senza cambiare la semantica della macchina ordine/coda.

## Modifica

Aggiunti marker interni in `handleIntegrationOrderSync()`:

- `revisionApply`
- `workflowApplyPlan`
- `workflowScopedMerge`
- `orderLabeler`
- `queueReconcile`
- `applyPlanQueue` come tail marker compatibile

Aggiunto guard statico `P3.49 orders/sync spacchetta applyPlanQueue`.

Budget `server.js`: 38.799 righe, invariato sotto M5.

## Verifiche

Locale:

- `node --check backend/server.js`: PASS
- `route-policy-architecture`: 99/99 PASS
- `runtime-metrics + order-preparation-queue`: 36/36 PASS

Raspberry:

- `server.js`: 38.799 righe
- `route-policy-architecture`: 99/99 PASS
- `runtime-metrics + order-preparation-queue`: 36/36 PASS
- Servizi attivi: owner, worker 5283/5284, realtime, frontend, batteria.
- Env sicurezza confermate su owner e worker.

## Canary

Run: `p3_49_apply_plan_split_c1_50_20260709`

| Metrica | P3.48 | P3.49 | Delta |
| --- | ---: | ---: | ---: |
| Esito | PASS 50/50 | PASS 50/50 | invariato |
| create p95 | 818.06 ms | 854.33 ms | +4.4% |
| sync p95 | 738.95 ms | 847.13 ms | +14.6% |
| readback p95 | 324.21 ms | 320.01 ms | -1.3% |
| cleanup p95 | 403.37 ms | 417.81 ms | +3.6% |

P3.49 e' diagnostica: il p95 sync peggiora rispetto al run P3.48, ma resta sotto P3.47. La lettura utile e' lo split dei costi.

## Split applyPlanQueue

| Worker | Segmento | Avg ms | Max ms | p95 bucket |
| --- | --- | ---: | ---: | ---: |
| 5283 | `workflowScopedMerge` | 140.32 | 176 | 250 |
| 5283 | `queueReconcile` | 96.12 | 207 | 250 |
| 5283 | `workflowApplyPlan` | 0.08 | 2 | 1 |
| 5283 | `revisionApply` | 0.12 | 1 | 1 |
| 5283 | `orderLabeler` | 0.12 | 2 | 1 |
| 5284 | `workflowScopedMerge` | 136.08 | 173 | 250 |
| 5284 | `queueReconcile` | 97.52 | 156 | 250 |
| 5284 | `workflowApplyPlan` | 0.08 | 1 | 1 |
| 5284 | `revisionApply` | 0.12 | 1 | 1 |
| 5284 | `orderLabeler` | 0.04 | 1 | 1 |

Altri blocchi ancora pesanti nello stesso run:

- `financialSync`: 185-205 ms avg.
- `relationalSnapshotRead`: 128-139 ms avg.
- `relationalWrite`: 7.56 ms avg su 5284, 42.52 ms avg su 5283 per un outlier max 587 ms.

## Lettura

`workflowApplyPlan` non e' il problema: costa circa zero. Il costo principale del vecchio `applyPlanQueue` e':

1. `workflowScopedMerge`, circa 136-140 ms avg.
2. `queueReconcile`, circa 96-98 ms avg.

Quindi P3.50 deve ridurre `workflowScopedMerge`: oggi `mergeIntegrationOrderWorkflowScopedOrders()` ricostruisce/fonde lo snapshot scoped sullo stato completo. Il prossimo taglio naturale e' un replace puntuale per gli ID gia noti del piano, con fallback al merge legacy quando lo snapshot non e' abbastanza deterministico.

## Prossimo step consigliato

P3.50:

- introdurre un merge scoped puntuale per `orders/sync`;
- usare gli ID di `orderWorkflowApplyPlan.orders`, `queuePromotions` e `selectionHandoffDemotions`;
- evitare la ricostruzione dell'indice globale quando si sta aggiornando un piccolo set noto;
- mantenere fallback `mergeIntegrationOrderWorkflowScopedOrders()` se mancano ID o lookup sicuro.

## Evidenze

- `reports/p3_49_apply_plan_split_20260709/canary/REPORT.md`
- `reports/p3_49_apply_plan_split_20260709/canary/result.json`
- `reports/p3_49_apply_plan_split_20260709/p3-49-all-runtime-metrics.json`
- `reports/p3_49_apply_plan_split_20260709/p3-49-worker-5283-runtime-metrics.json`
- `reports/p3_49_apply_plan_split_20260709/p3-49-worker-5284-runtime-metrics.json`
- `reports/p3_49_apply_plan_split_20260709/p3-49-order-sync-internal-summary.tsv`
- `reports/p3_49_apply_plan_split_20260709/p3-49-services.txt`
