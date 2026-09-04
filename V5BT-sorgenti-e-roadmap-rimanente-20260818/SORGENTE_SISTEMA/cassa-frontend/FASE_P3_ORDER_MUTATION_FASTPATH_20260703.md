# Fase P3.16 - comp/correct/cancel fast path puntuale

Data: 2026-07-03

## Obiettivo

Ridurre il peso delle mutazioni ordine secondarie prima di riprovare ad
aumentare la concorrenza dell'`order-lane`.

Lo step segue il prossimo punto lasciato in `FASE_P3_ORDER_INDEX_PRECISE_20260703.md`:
portare `comp/correct/cancel` sullo stesso sync puntuale usato da
`writeIntegrationOrderSyncDb`, senza tornare al full-domain `writeIntegrationOrderDb`.

## Modifica

File:

- `backend/server.js`
- `backend/modules/integration/integration-object-fields.js`
- `backend/modules/runtime-metrics.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/runtime-metrics.test.mjs`

Dettaglio:

- aggiunto `syncIntegrationObjectFieldsFastPath` per sincronizzare singoli campi
  laterali di `integration`;
- `writeIntegrationOrderSyncDb` ora accetta `integrationObjectFields`;
- `orders/comp` sincronizza in modo puntuale:
  - ordini toccati;
  - `orderComps`;
  - `barChargeReplacements` quando presente;
  - audit espliciti;
  - eventuale `posSettings.tables`;
- `orders/correct` sincronizza in modo puntuale:
  - ordine corretto;
  - `orderCorrections`;
  - audit espliciti;
  - eventuale `posSettings.tables`;
- `orders/cancel` sincronizza in modo puntuale:
  - ordine annullato;
  - audit espliciti;
  - eventuale `posSettings.tables`.

Ho spostato il piccolo helper in un modulo dedicato per non far crescere
`server.js`: il file resta a 38.772 righe, quindi dentro il gate M5.

## Test

Verifiche locali:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/integration-object-fields.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/modules/runtime-metrics.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Risultato:

- sintassi: ok;
- architettura/runtime: 38/38 pass;
- label diagnostiche P3 preservate anche per:
  - `orderWorkflow:orders.comp.appStateWrite`;
  - `orderWorkflow:orders.correct.appStateWrite`;
  - `orderWorkflow:orders.cancel.appStateWrite`.

## Load 50

Run:

- `logs/loadtest-phaseP_v5_p317_comp_correct_cancel_fastpath_50/REPORT.md`
- `logs/loadtest-phaseP_v5_p317_comp_correct_cancel_fastpath_50/report.json`

Configurazione:

- 50 palmari API;
- 10 postazioni API;
- 3 GUI Playwright;
- 20 operazioni per device;
- stampante simulata;
- fiscale virtuale su `127.0.0.1:9290`.

Risultati:

- durata: 241 s;
- business ops: 1260;
- HTTP: 3121;
- failure: 0;
- anomalie finali: 0;
- RT virtuale: 3/3 successi HTTP;
- RT provider receipts: 20;
- coda finale `dbMutation/orderLane`: 0 / 0;
- `events.jsonl`: 0 fail-like, 0 retry-like.

Confronto indicativo col run stabile P3.15:

- durata: 262 s -> 241 s;
- HTTP: 3231 -> 3121;
- failure: 0 -> 0;
- `order.correct` p95: 22654 ms -> 20943 ms;
- `order.comp` p95: 19416 ms -> 17467 ms.

Le latenze restano pero' dominate dall'attesa in lane, non dal tempo di handler:

- queue wait `POST /api/integration/orders/sync`: p95 27685 ms;
- queue wait `POST /api/integration/orders/create`: p95 25860 ms;
- queue wait `POST /api/integration/orders/correct`: p95 23939 ms;
- queue wait `POST /api/integration/orders/comp`: p95 21895 ms;
- runtime `orderWorkflow:orders.create.appStateWrite`: avg 532.9 ms, p95 <=2500 ms;
- runtime `orderWorkflow:orders.sync.appStateWrite`: avg 873.54 ms, p95 <=2500 ms.

## Stato

Step P3.16 completato.

La correttezza sotto load resta pulita e non sono riemersi retry MySQL o
`orderStationIndex`. P3 non e' ancora chiusa sul gate di latenza: il collo
residuo e' la coda dell'`order-lane` durante burst a 50 device.

## Prossimo passo consigliato

Riprovare il canary `ORDER_SYNC_FAST_LANE_CONCURRENCY=8` dopo questo alleggerimento.

Se resta senza retry:

1. promuovere gradualmente la concorrenza;
2. continuare a ridurre il costo dei passaggi `auditRecent` e `posSettingsTables`;
3. fissare un gate P3 separato tra correttezza zero-retry e latenza p95.

Se riappare un retry:

1. tenere default a 6;
2. lavorare sullo split di `auditRecent`/print spool prima di un nuovo probe.
