# Fase P3.50 - Changed-only scoped merge

Data: 2026-07-09
Target: Raspberry 192.168.0.67
Profilo test: stampa/fiscale/cassa automatica reale disattivati.

## Obiettivo

Ridurre il costo CPU di `orderSyncInternal:workflowScopedMerge`, emerso in P3.49 come collo del path `/api/integration/orders/sync`.

## Implementazione

- `backend/modules/orders/order-preparation-queue.js`
  - Aggiunto merge scoped fast con hint verificati.
  - L'hint ordinale usa id progressivi quando l'array e' ancora ordinale.
  - L'hint di coda recente (`scopedMergeTailSize`) copre gli ordini appena creati quando l'array app-state non e' piu ordinale.
  - Ogni hint viene accettato solo se l'ordine in posizione combacia con il lookup id; altrimenti resta il fallback sicuro.
- `backend/server.js`
  - `orders/sync` non passa piu tutto lo snapshot scoped al mirror app-state.
  - Il merge riceve solo gli ordini realmente cambiati: ordine target + eventuali demotion di selezione.
  - Budget `server.js`: 38.798 righe, sotto il gate M5.
- Test aggiornati:
  - `backend/tests/order-preparation-queue.test.mjs`
  - `backend/tests/route-policy-architecture.test.mjs`

## Verifica

Locale:

- `node --check backend/server.js`: OK
- `node --check backend/modules/orders/order-preparation-queue.js`: OK
- `order-preparation-queue + runtime-metrics`: 39/39 OK
- `route-policy-architecture`: 100/100 OK

Raspberry:

- `server.js`: 38.798 righe
- `route-policy-architecture`: 100/100 OK
- `order-preparation-queue + runtime-metrics`: 39/39 OK
- Servizi attivi: backend owner, worker 5283/5284, realtime, frontend, battery.
- Env safety confermati su owner e worker:
  - `PRINTING_ENABLED=0`
  - `FISCAL_REAL_IO_DISABLED=1`
  - `POS_FISCAL_REAL_IO_DISABLED=1`
  - `AUTOMATIC_CASH_REAL_ENABLED=0`

## Canary 50 device-equivalent

Run: `p3_50c_changed_only_scoped_merge_c1_50_20260709`

| metrica | P3.49 baseline step | P3.50c |
| --- | ---: | ---: |
| esito | PASS 50/50 | PASS 50/50 |
| create p95 | 854.33 ms | 831.18 ms |
| sync p95 | 847.13 ms | 867.33 ms |
| readback p95 | 320.01 ms | 400.26 ms |
| cleanup p95 | 417.81 ms | 473.28 ms |

## Split interno orders/sync

| label | P3.49 avg 5283/5284 | P3.50c avg 5283/5284 | esito |
| --- | ---: | ---: | --- |
| workflowScopedMerge | 140.32 / 136.08 ms | 2.52 / 3.20 ms | RISOLTO |
| financialSync | 205.44 / 185.48 ms | 226.28 / 219.60 ms | prossimo collo |
| preparationPlan | 0.08 / 0.12 ms | 107.20 / 123.88 ms | prossimo collo |
| queueReconcile | 96.12 / 97.52 ms | 101.52 / 97.88 ms | ancora alto |
| relationalSnapshotRead | 138.68 / 127.92 ms | 142.48 / 143.32 ms | ancora alto |

Nota: P3.50b con solo hint ordinale/tail senza filtro changed-only e' stato scartato: PASS 50/50 ma `workflowScopedMerge` peggiorava a 183.44 / 197.96 ms medi, perche lo snapshot scoped conteneva molti ordini di postazione.

## Conclusione

Gate tecnico P3.50 sul merge scoped: verde.

Il costo `workflowScopedMerge` e' passato da circa 136-140 ms medi a circa 2.5-3.2 ms medi. Il p95 esterno non crolla ancora perche il collo e' ora altrove: `financialSync`, `preparationPlan`, `queueReconcile` e lettura snapshot relazionale.

## Prossimo step consigliato

P3.51: separare e ridurre `preparationPlan`.

Motivo: dopo P3.50c il piano preparazione pesa 107-124 ms medi sui worker. Probabile causa: conteggio/validazione lane su snapshot scoped di postazione. Il prossimo intervento dovrebbe:

- spacchettare `preparationPlan` in sotto-metriche;
- evitare scansioni complete quando lo status non entra in `prep`;
- usare lane target gia calcolata e contatori puntuali per `countPreparingIntegrationOrdersInLane`;
- mantenere fallback sicuro quando ci sono demotion o cambi di selezione.

