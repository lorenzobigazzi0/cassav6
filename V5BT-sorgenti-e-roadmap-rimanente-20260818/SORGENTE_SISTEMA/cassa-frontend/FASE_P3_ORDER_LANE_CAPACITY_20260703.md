# Fase P3 interinale - Capacity probe order lane

Data: 2026-07-03

## Obiettivo

Continuazione del Passo 3 di `ROADMAP_INTERINALE_P3_LATENZA.md`: dopo i bucket
diagnostici, verificare se il p95 alto della `order lane` e' risolvibile
aumentando la concorrenza oppure se serve ridurre il costo medio delle write.

## Modifica

Il cap della `order lane` non e' piu' hard-coded a 8:

- default operativo invariato: `ORDER_SYNC_FAST_LANE_CONCURRENCY=6`
- cap default invariato: `ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY=8`
- canary espliciti oltre 8 possibili solo impostando
  `ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY`

Questo permette probe controllati senza cambiare il comportamento standard.

## Verifica statica

Comandi:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/modules/orders/order-lane-metrics.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito: 46/46 pass.

`server.js` resta dentro il gate M5:

- `wc -l`: 38.794
- linee contate dal test: 38.795
- margine: 705 righe

## Canary 8 post-cache

Run: `phaseP_interinale_p3_order_bucket_cache_canary_50`

- durata: 198,4 s
- business ops: 1260
- HTTP: 2968
- failure: 0
- fiscale virtuale: 5/5

Metriche principali:

- `order.create`: p50 11.867 ms, p95 14.678 ms, p99 15.147 ms
- `order.sync.ready`: p50 12.429 ms, p95 14.890 ms, p99 15.460 ms
- `order.sync.delivered`: p50 12.275 ms, p95 14.817 ms, p99 15.303 ms
- `order.correct`: p95 14.231 ms
- `station.heartbeat`: p95 6.528 ms
- `waiter.pause.start`: p95 13.845 ms
- `waiter.pause.stop`: p95 18.018 ms

Osservazione: i bucket piccoli e grandi hanno attese simili. Esempi:

- `sync lines=6-10 qty=6-10`: wait p95 15.682 ms
- `create lines=1 qty=1`: wait p95 14.545 ms
- `sync lines=21p qty=21p`: wait p95 14.391 ms
- `create lines=11-20 qty=21p`: wait p95 13.886 ms

Quindi non c'e' evidenza forte di head-of-line causato solo dagli ordini grandi.

Retry/deadlock:

- 1 retry transient su `waiter.pause.start.appStateWrite`
- nessun retry/deadlock order-lane

## Canary 12

Run: `phaseP_interinale_p3_order_lane12_canary_50`

Env:

- `ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY=12`
- `ORDER_SYNC_FAST_LANE_CONCURRENCY=12`

Risultato:

- durata: 213,0 s
- business ops: 1260
- HTTP: 2839
- failure: 0
- fiscale virtuale: 3/3

Metriche principali:

- `order.create`: p50 11.786 ms, p95 17.876 ms, p99 20.266 ms
- `order.sync.ready`: p50 12.241 ms, p95 17.111 ms, p99 18.104 ms
- `order.sync.delivered`: p50 11.294 ms, p95 17.281 ms, p99 18.244 ms
- `order.correct`: p95 17.599 ms
- `station.heartbeat`: p95 21.160 ms
- `waiter.pause.start`: p95 35.644 ms
- `waiter.pause.stop`: p95 41.228 ms

Retry/deadlock:

- 1 retry transient su `waiter.pause.stop.appStateWrite`
- nessun retry/deadlock order-lane

## Decisione

Non promuovere concorrenza 12. Il canary 12 peggiora:

- durata totale: 198,4 s -> 213,0 s
- `order.create` p95: 14.678 ms -> 17.876 ms
- `order.sync.ready` p95: 14.890 ms -> 17.111 ms
- `station.heartbeat` p95: 6.528 ms -> 21.160 ms
- `waiter.pause.stop` p95: 18.018 ms -> 41.228 ms

La concorrenza oltre 8 aumenta la pressione su MySQL e sulle lane laterali senza
ridurre la coda ordine. Il cap configurabile resta utile per futuri canary, ma
la soglia operativa resta 8.

## Prossimo passo

Restare nel Passo 3, ma spostare il lavoro dal scheduling alla riduzione costo:

1. ottimizzare `orders.sync.mysql.orders`, che nel canary 8 ha avg 440 ms e nel
   canary 12 sale a 688 ms;
2. ridurre ulteriormente `orders.create.mysql.orders` e
   `orders.create.mysql.posSettingsTables`;
3. trattare separatamente i retry `waiter.pause.*`, perche' non sono order-lane
   ma bloccano il gate globale zero-retry.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_order_bucket_cache_canary_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_bucket_cache_canary_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_lane12_canary_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_lane12_canary_50/REPORT.md`
