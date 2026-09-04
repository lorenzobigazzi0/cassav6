# Fase P3 - Terminal Sync Pre-lane

Data: 2026-07-03

## Obiettivo

Continuazione del Passo 3 di `ROADMAP_INTERINALE_P3_LATENZA.md`: spostare il
riconoscimento delle sync terminali duplicate prima della `order lane`, in modo
che i reinvii `ready`/`delivered` su una comanda gia' `delivered` non occupino
worker ordine quando non devono mutare stato.

## Modifiche

- Aggiunto `backend/modules/orders/terminal-duplicate-sync-prelane.js`.
- Il pre-lane intercetta solo `POST /api/integration/orders/sync`.
- Il ramo risponde no-op solo se:
  - il write-primary relazionale non e' attivo;
  - il body contiene `id` e ordine;
  - il workflow richiesto normalizza a `ready` o `delivered`;
  - la sessione e' valida;
  - l'ordine corrente esiste, non e' cancellato ed e' gia' `delivered`.
- In caso di mismatch o errore il ramo fallisce aperto e lascia proseguire il
  percorso normale, quindi la `order lane` resta autoritativa.
- Aggiunto counter runtime `orderTerminalDuplicateSyncPreLaneNoops`.
- I report load ora distinguono:
  - no-op terminali totali;
  - no-op pre-lane;
  - enqueue effettivi della `order lane`.

## Test

Comandi eseguiti:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/orders/terminal-duplicate-sync-prelane.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/loadtest-full-capacity.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/endurance-sim-50k.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs
```

Risultati:

- Runtime metrics + architettura: 47/47 pass.
- Orders flow + CAS relazionale: 8/8 pass.
- `server.js`: 38.797 righe, dentro il margine M5.

## Load smoke

Run: `phaseP_interinale_p3_terminal_prelane_smoke_20`

- Durata: 41 s
- Business ops: 240
- Failure: 0
- Fiscale reale: 0 tentativi
- Sync terminali duplicate no-op: 1 / 37, pre-lane 1
- `orderLaneEnqueued`: 124

Metriche principali:

- `station.heartbeat` p95: 5068 ms
- `order.create` p95: 2856 ms
- `order.sync.delivered` p95: 2543 ms
- `order.sync.ready` p95: 2180 ms
- `order.correct` p95: 2109 ms

## Canary medio

Run: `phaseP_interinale_p3_terminal_prelane_canary12_50`

- Durata: 109 s
- Business ops: 720
- Failure: 0
- Fiscale reale: 0 tentativi
- DB: circa 68,53 MB
- Sync terminali duplicate no-op: 28 / 108, 25,93%, pre-lane 23
- `orderLaneEnqueued`: 301

Metriche principali:

- `station.heartbeat` p95: 1667 ms
- `order.create` p95: 17691 ms
- `order.sync.delivered` p95: 17522 ms
- `order.sync.ready` p95: 13360 ms
- `order.correct` p95: 18081 ms
- `order.comp` p95: 10634 ms

## Confronto con baseline counter

Baseline comparabile: `phaseP_interinale_p3_terminal_noop_counter_canary12_50`

- Durata: 115 s
- Business ops: 720
- Failure: 0
- Sync terminali duplicate no-op: 26 / 114, 22,81%
- `orderLaneEnqueued`: 343
- `station.heartbeat` p95: 5645 ms
- `order.create` p95: 13271 ms
- `order.sync.delivered` p95: 13706 ms
- `order.sync.ready` p95: 13795 ms
- `order.correct` p95: 13953 ms
- `order.comp` p95: 836 ms

Effetto osservato:

- `orderLaneEnqueued`: 343 -> 301, cioe' -42 enqueue (-12,2%).
- durata totale: 115 s -> 109 s.
- zero failure in entrambi i run.
- forte miglioramento su `station.heartbeat`.
- segnale misto sui p95 ordine: `sync.ready` resta simile, ma `create`,
  `delivered`, `correct` e `comp` peggiorano nel campione casuale.

## Decisione

La patch resta promossa come riduzione di pressione e come miglioramento di
coerenza/idempotenza: intercetta duplicati reali prima della `order lane` e
mantiene invariati CAS, audit e flussi mutanti.

Non chiude pero' il gate latenza P3. Il miglioramento misurabile e' sulla
pressione della coda, non ancora sulla distribuzione p95 delle operazioni
ordine. Il prossimo step deve quindi restare sul Passo 3, ma spostarsi sui
veri outlier di costo:

1. `orders.create.mysql.orders` e `orders.sync.mysql.orders`;
2. `orders.create.mysql.posSettingsTables`;
3. `correct`/`comp`, che nel canary medio restano nella stessa coda lunga;
4. retry laterali `waiter.pause.*`, per il gate globale zero-retry.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_terminal_prelane_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_terminal_prelane_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_terminal_prelane_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_terminal_prelane_canary12_50/REPORT.md`
