# Fase P3 - Probe priorita order lane

Data: 2026-07-03

## Obiettivo

Verificare se una priorita interna alla `orderSyncLaneQueue` puo ridurre la latenza delle comande live sotto carico 50 palmari, mantenendo corretti storni/correzioni e senza aumentare errori o retry.

## Baseline usato

Run: `phaseP_interinale_p3_order_bucket_cache_canary_50`

- Palmari API: 50
- Postazioni API: 10
- GUI Playwright: 3
- Operazioni per device: 20
- Failure: 0
- `order.create` p95: 14678 ms
- `order.sync.ready` p95: 14890 ms
- `order.sync.delivered` p95: 14817 ms
- `order.correct` p95: 14231 ms
- `order.comp` p95: 13215 ms
- `payment.free_split` p95: 12382 ms
- `reservation.create` p95: 12543 ms
- `station.heartbeat` p95: 6528 ms

## Probe 1: priorita rigida create/sync

Run: `phaseP_interinale_p3_order_priority_canary8_50`

Modifica provata:

- `create`/`sync`: priorita 2
- `comp`/`storno`/`correct`/`cancel`: priorita 3
- `station reconciliation`: priorita 4

Esito:

- Failure: 0
- `order.create` p95: 12203 ms
- `order.sync.ready` p95: 12573 ms
- `order.sync.delivered` p95: 12497 ms
- `order.correct` p95: 92313 ms
- `order.comp` p95: 63449 ms
- `payment.free_split` p95: 8918 ms
- `reservation.create` p95: 12313 ms
- `station.heartbeat` p95: 4482 ms

Conclusione: respinta. Migliora il percorso create/sync, ma affama storni e correzioni fino a latenze operative non accettabili.

## Probe 2: priorita con anti-starvation

Run: `phaseP_interinale_p3_order_priority_aging_canary8_50`

Modifica provata:

- stessa priorita della probe 1
- promozione delle task a priorita 3 dopo `DB_MUTATION_SLOW_WAIT_MS * 5`

Esito:

- Failure: 0
- `order.create` p95: 17158 ms
- `order.sync.ready` p95: 16598 ms
- `order.sync.delivered` p95: 16583 ms
- `order.correct` p95: 17480 ms
- `order.comp` p95: 13733 ms
- `payment.free_split` p95: 12211 ms
- `reservation.create` p95: 9489 ms
- `station.heartbeat` p95: 2291 ms

Conclusione: respinta. Evita l'affamamento estremo, ma peggiora il percorso ordine rispetto al baseline e non chiude il collo di bottiglia P3.

## Stato runtime

Le modifiche runtime della probe sono state rimosse.

`orderSyncLaneTaskPriority` e tornata alla policy precedente:

- `station reconciliation`: priorita 4
- `create` e resto workflow ordini: priorita 2

## Verifiche

- `node --check cassa-frontend/backend/server.js`: OK
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`: OK dopo rollback runtime
- `phaseP_interinale_p3_order_priority_smoke_20`: OK, 0 failure
- `phaseP_interinale_p3_order_priority_canary8_50`: OK, 0 failure, respinta per starvation
- `phaseP_interinale_p3_order_priority_aging_canary8_50`: OK, 0 failure, respinta per regressione p95 ordine

## Prossimo step consigliato

Non lavorare ancora su priorita statiche della order lane. Il prossimo step P3 deve puntare a ridurre il lavoro per singola task:

1. coalescing/squashing dei sync `ready` e `delivered` sullo stesso ordine quando arrivano ravvicinati;
2. riduzione dei lock/tavolo attorno a `order.create` e `order.sync`;
3. separazione diagnostica tra tempo di attesa lane e tempo di esecuzione MySQL per bucket `create/sync`.

