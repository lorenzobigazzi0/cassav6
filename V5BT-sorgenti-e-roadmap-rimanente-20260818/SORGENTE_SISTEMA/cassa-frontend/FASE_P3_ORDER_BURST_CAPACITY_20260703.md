# Fase P3 - Order burst capacity

Data: 2026-07-03

## Obiettivo

Seguire il prossimo step di `FASE_P3_ORDER_POSSETTINGS_SCOPE_20260703.md`:
calcolare la capacita' effettiva della `orderLane` e verificare se la coda lunga
dipende da capacita' media insufficiente oppure da burst non assorbiti.

## Calcolo capacita'

Baseline post `posSettings`:
`phaseP_interinale_p3_possync_scope_canary12_50`

- Durata: 104,756 s
- `orderLaneEnqueued`: 306
- Arrivo osservato: 2,92 task/s
- Run medio `orderLane`: 1152,95 ms
- Capacita' teorica a 8 worker: 6,94 task/s
- Margine teorico: +137,5%
- Wait medio `orderLane`: 6356,01 ms
- Wait p95 max `orderLane`: 11823 ms

La capacita' media risulta sufficiente, ma la wait resta alta. Il problema
rimasto non e' quindi il throughput medio, ma la capacita' di assorbire i burst.

## Diagnosi scheduler

La concorrenza P3/P4 era gia' portata a 8 tramite env:

```env
ORDER_SYNC_FAST_LANE_CONCURRENCY=8
ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY=8
```

Il burst pero' restava di default a 6:

```env
ORDER_SYNC_FAST_LANE_BURST=6
```

Quindi, sotto coda mista con `dbMutationQueue` non vuota, la lane ordini poteva
non riempire tutti gli slot disponibili. I log mostravano code residue frequenti
intorno a 30-34 task, anche su ordini piccoli.

## Canary burst 16

Run: `phaseP_interinale_p3_order_burst16_canary12_50`

Configurazione uguale al canary precedente, aggiungendo solo:

```env
ORDER_SYNC_FAST_LANE_BURST=16
```

Risultati:

- Durata: 99,114 s
- Business ops: 720
- HTTP: 1792
- Failure: 0
- RT fiscale reale: 0 tentativi
- Retry/deadlock/timeout nei log: 0
- `orderLaneEnqueued`: 305
- Arrivo osservato: 3,08 task/s
- Run medio `orderLane`: 1043,98 ms
- Capacita' teorica a 8 worker: 7,66 task/s
- Margine teorico: +149,0%
- Wait medio `orderLane`: 5899,66 ms
- Wait p95 max `orderLane`: 10802 ms

| Metrica | Burst 6 | Burst 16 |
|---|---:|---:|
| `order.create` p95 | 11926 ms | 10453 ms |
| `order.sync.ready` p95 | 10832 ms | 10512 ms |
| `order.sync.delivered` p95 | 10843 ms | 10376 ms |
| `order.correct` p95 | 12304 ms | 10087 ms |
| `payment.free_split` p95 | 4277 ms | 3666 ms |
| `station.heartbeat` p95 | 1479 ms | 1171 ms |
| `waiter.pause.start` p95 | 11233 ms | 9639 ms |
| `waiter.pause.stop` p95 | 10275 ms | 6435 ms |
| `orderLane` wait avg | 6356 ms | 5900 ms |
| `orderLane` wait p95 max | 11823 ms | 10802 ms |

## Modifica

Il default di `ORDER_SYNC_FAST_LANE_BURST` ora scala con la concorrenza:

```js
Math.max(ORDER_SYNC_FAST_LANE_CONCURRENCY * 2, 12)
```

Con concorrenza 8 il default diventa 16; con il default storico a 6 worker il
burst diventa 12. Il limite massimo resta 50 e l'env continua a poter
sovrascrivere il valore.

Guardrail aggiunto in `route-policy-architecture.test.mjs` per impedire il
ritorno a un burst fisso sotto gli slot disponibili.

## Verifiche

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Risultati:

- Architettura + runtime metrics: 48/48 pass.
- `server.js`: 38.794 righe, sotto budget M5.

## Smoke default post-modifica

Run: `phaseP_interinale_p3_order_burst_default_smoke_20`

Senza `ORDER_SYNC_FAST_LANE_BURST` esplicito, con concorrenza 8.

- Durata: 35 s
- Business ops: 150
- HTTP: 509
- Failure: 0
- RT fiscale reale: 0 tentativi
- Retry/deadlock/timeout nei log: 0
- `order.create` p95: 3099 ms
- `order.sync.delivered` p95: 2200 ms
- `station.heartbeat` p95: 281 ms
- `waiter.pause.start` p95: 987 ms
- `waiter.pause.stop` p95: 1295 ms
- `orderLane` wait avg: 769,21 ms
- `orderLane` run avg: 510,46 ms

## Decisione

Promosso come tuning di capacita' burst. Non chiude P3:

- il canary grande migliora, ma `order.create`/`sync` restano intorno a 10 s
  p95;
- il calcolo mostra che il margine medio esiste gia', quindi la prossima
  correzione deve ridurre i burst o separare le operazioni leggere da quelle
  che tengono occupati gli slot per oltre 1-2 secondi;
- non sono emersi retry/deadlock/timeout.

## Prossimo step

Provare una lane separata o una priorita' piu' aggressiva per le create/sync
leggere, mantenendo correct/comp e ordini grandi meno invasivi. Il canary dovra'
confrontare:

- `order.create`/`order.sync` p95;
- wait p95 della `orderLane`;
- `waiter.pause.*` e `station.heartbeat`;
- zero retry/deadlock su ordini, tavoli, pagamenti e prenotazioni.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_order_burst16_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_burst16_canary12_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_burst_default_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_burst_default_smoke_20/REPORT.md`
