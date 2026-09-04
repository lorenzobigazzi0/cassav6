# Fase P3 interinale - Bucket diagnostici order lane

Data: 2026-07-03

## Obiettivo

Passo 3 di `ROADMAP_INTERINALE_P3_LATENZA.md`: capire se la coda lunga della
`order lane` dipende da ordini pesanti oppure da saturazione/FIFO generale.

## Modifiche

- Aggiunto `backend/modules/orders/order-lane-metrics.js`.
- Le label della `order lane` ora includono bucket a bassa cardinalita':
  - `lines`
  - `qty`
  - `routes`
  - `reason`
  - `notes`
- Aggiunta cache diagnostica in memoria per ordine:
  - `create` registra dimensione reale dell'ordine;
  - `sync/correct/comp` possono ereditare quei bucket senza leggere il DB prima
    dell'accodamento.

Il comportamento API non cambia: sono solo label runtime per `waitMsByLabel` e
`runMsByLabel`.

## Guardrail

Aggiornato `backend/tests/route-policy-architecture.test.mjs`:

- la `order lane` deve usare `orderLaneMetricLabeler.buildLabel(req, pathname)`;
- il modulo deve mantenere `lines/qty/routes/notes`;
- create e sync devono aggiornare la cache con `rememberOrder`.

`server.js` resta dentro il gate M5:

- `wc -l`: 38.799
- linee contate dal test: 38.800
- margine: 700 righe esatte

## Verifica

Comandi:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/modules/orders/order-lane-metrics.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito: 46/46 pass.

## Load 50 diagnostico

Run: `phaseP_interinale_p3_order_bucket_probe_50`

- durata: 219 s
- business ops: 1260
- HTTP: 2955
- failure: 0
- fiscale virtuale: 3/3
- DB scritto: circa 175,99 MB

Risultati principali:

- `order.create`: p50 14.210 ms, p95 18.250 ms, p99 19.464 ms
- `order.sync.ready`: p95 26.291 ms, p99 32.848 ms
- `order.sync.delivered`: p95 18.656 ms, p99 34.796 ms
- `table.room_move.request`: p95 4.923 ms, ancora pulito lato Tavoli/Sale

Le label `create` hanno mostrato bucket distinti, ma le `sync` del run erano
ancora `lines=0 qty=0` perche' molte richieste portano solo patch/stato. Da qui
la cache diagnostica aggiunta dopo il run.

## Smoke post-cache

Run: `phaseP_interinale_p3_order_bucket_cache_smoke_20`

- durata: 39,2 s
- business ops: 240
- HTTP: 660
- failure: 0
- retry/deadlock cercati nei log: nessuno

La cache funziona: le `sync` non collassano piu' su `0/0`, ma compaiono con
bucket ereditati dall'ordine:

- `orders/sync lines=1 qty=1 routes=1`
- `orders/sync lines=6-10 qty=6-10 routes=2-3`
- `orders/sync lines=6-10 qty=6-10 routes=4-5`
- `orders/sync lines=21p qty=21p routes=11-20`

## Decisione

Il Passo 3 e' ora strumentato correttamente. Non promuovere ancora una nuova
priorita' o lane separata: il primo run completo indica saturazione order lane,
ma la parte `sync` aveva label insufficienti. Il prossimo step deve essere un
canary 50 post-cache con concorrenza 8; se i bucket grandi dominano p95/p99, si
separano le operazioni pesanti. Se invece tutti i bucket restano simili, il
problema e' throughput/capacita' della lane o costo medio delle write, non
dimensione ordine.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_order_bucket_probe_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_bucket_probe_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_bucket_probe_50/backend.log`
- `logs/loadtest-phaseP_interinale_p3_order_bucket_cache_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_bucket_cache_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_bucket_cache_smoke_20/backend.log`
