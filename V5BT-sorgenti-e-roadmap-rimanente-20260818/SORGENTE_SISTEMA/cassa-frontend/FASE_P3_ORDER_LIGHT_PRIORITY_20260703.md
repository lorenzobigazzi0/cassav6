# Fase P3 - Order light priority

Data: 2026-07-03

## Obiettivo

Proseguire dopo `FASE_P3_ORDER_BURST_CAPACITY_20260703.md`: verificare se una
priorita' piu' aggressiva per create/sync leggere riduce il p95 della
`orderLane` senza penalizzare correct/comp e le lane laterali.

## Esperimento 1 - priorita' leggera pura

Modifica provata:

- create/sync leggere: priorita' 1;
- create/sync normali: priorita' 2;
- correct/comp/cancel: priorita' 3;
- station reconciliation: priorita' 4.

Run: `phaseP_interinale_p3_order_lightprio_canary12_50`

- Business ops: 720
- Failure: 0
- RT fiscale reale: 0 tentativi
- Retry/deadlock/timeout nei log: 0

Esito:

| Metrica | Burst 16 | Light priority |
|---|---:|---:|
| `order.create` p95 | 10453 ms | 7298 ms |
| `order.create.long` p95 | 10702 ms | 19162 ms |
| `order.sync.ready` p95 | 10512 ms | 12443 ms |
| `order.sync.delivered` p95 | 10376 ms | 14274 ms |
| `order.correct` p95 | 10087 ms | 44919 ms |
| `orderLane` wait p95 max | 10802 ms | 42855 ms |

Decisione: respinto. Migliora la create piccola, ma affama correct e ordini
lunghi.

## Esperimento 2 - priorita' leggera con aging

Modifica provata:

- stessa priorita' dell'esperimento 1;
- aging anti-starvation ogni 3000 ms;
- station reconciliation esclusa dall'aging e lasciata in fondo.

Run: `phaseP_interinale_p3_order_lightprio_aging_canary12_50`

- Business ops: 720
- Failure: 0
- RT fiscale reale: 0 tentativi
- Retry/deadlock/timeout nei log: 0

Esito:

| Metrica | Burst 16 | Light priority + aging |
|---|---:|---:|
| `order.create` p95 | 10453 ms | 11238 ms |
| `order.create.long` p95 | 10702 ms | 11080 ms |
| `order.sync.ready` p95 | 10512 ms | 10672 ms |
| `order.sync.delivered` p95 | 10376 ms | 10247 ms |
| `order.correct` p95 | 10087 ms | 11074 ms |
| `payment.free_split` p95 | 3666 ms | 3880 ms |
| `station.heartbeat` p95 | 1171 ms | 1996 ms |
| `waiter.pause.start` p95 | 9639 ms | 5773 ms |
| `waiter.pause.stop` p95 | 6435 ms | 6242 ms |
| `orderLane` wait p95 max | 10802 ms | 10912 ms |

Decisione: respinto. L'aging corregge la starvation estrema, ma non batte il
burst 16 stabile: create, correct e heartbeat peggiorano, con beneficio solo
marginale su delivered e waiter pause.

## Stato finale codice

La priorita' light e l'aging sono stati rimossi. Rimane promosso solo il tuning
del passo precedente:

```js
ORDER_SYNC_FAST_LANE_BURST = max(ORDER_SYNC_FAST_LANE_CONCURRENCY * 2, 12)
```

La `orderLane` torna alla priorita' stabile:

- workflow live: priorita' 2;
- station reconciliation: priorita' 4.

## Verifiche finali

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Risultati:

- Architettura + runtime + budget: 49/49 pass.
- `server.js`: 38.794 righe, sotto budget M5.
- Nessun helper sperimentale residuo:
  - `ORDER_SYNC_FAST_LANE_PRIORITY_AGING_MS`: assente;
  - `orderLaneBucketLimit`: assente;
  - `orderSyncLaneEffectivePriority`: assente.

## Prossimo step

Non insistere sulla priorita' light. Il collo residuo va attaccato prima
dell'ingresso in `orderLane` o riducendo ulteriormente il lavoro per task:

1. aumentare i no-op/pre-lane reali per sync terminali e richieste gia'
   idempotenti;
2. isolare correct/comp in fast path piu' stretto senza cambiare priorita'
   globale;
3. valutare una lane fisicamente separata solo se ha chiavi e budget propri,
   non come semplice priorita' dentro la stessa coda.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_order_lightprio_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_lightprio_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_lightprio_aging_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_lightprio_aging_canary12_50/report.json`
