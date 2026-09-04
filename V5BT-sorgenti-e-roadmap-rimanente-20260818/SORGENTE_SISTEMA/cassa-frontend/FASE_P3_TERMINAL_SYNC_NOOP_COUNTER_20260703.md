# Fase P3 - Terminal Sync No-op Counter

## Obiettivo

Dopo il no-op idempotente sulle sync terminali duplicate, misurare l'hit-rate reale del percorso per capire se e' solo una correzione di coerenza o anche una possibile leva sulla pressione della order lane.

## Modifiche

- Aggiunto counter runtime `orderTerminalDuplicateSyncNoops`.
- Il counter viene incrementato nel ramo:
  - comanda corrente `delivered`;
  - sync richiesta `ready` o `delivered`;
  - write-primary relazionale disattivato.
- I report di load ora mostrano:
  - `Sync terminali duplicate no-op: X / Y (Z%)`
  - dove `Y` e' il numero di richieste `POST /api/integration/orders/sync`.
- Aggiornati sia `loadtest-full-capacity.mjs` sia `endurance-sim-50k.mjs`.

## Test

Comandi eseguiti:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/loadtest-full-capacity.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/endurance-sim-50k.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs
```

Risultati:

- Runtime + architettura: 47/47 pass
- Orders flow + relazionale CAS: 7/7 pass
- `server.js`: 38.798 righe, margine M5 invariato a 702 righe

## Load smoke

Run: `phaseP_interinale_p3_terminal_noop_counter_smoke_20`

- 20 palmari API
- 10 postazioni API
- Operazioni per device: 8
- Business ops: 240
- Failure: 0
- Durata: 36 s
- RT fiscale: 0 tentativi
- Sync terminali duplicate no-op: 4 / 41, 9,76%

Metriche principali:

- `order.create` p95: 2944 ms
- `order.sync.delivered` p95: 2371 ms
- `order.sync.ready` p95: 3097 ms
- `station.heartbeat` p95: 757 ms

## Load canary medio

Run: `phaseP_interinale_p3_terminal_noop_counter_canary12_50`

- 50 palmari API
- 10 postazioni API
- Operazioni per device: 12
- Business ops: 720
- Failure: 0
- Durata: 115 s
- RT fiscale: 0 tentativi
- Sync terminali duplicate no-op: 26 / 114, 22,81%

Metriche principali:

- `order.create` p95: 13271 ms
- `order.sync.delivered` p95: 13706 ms
- `order.sync.ready` p95: 13795 ms
- `order.correct` p95: 13953 ms
- `order.comp` p95: 836 ms
- `station.heartbeat` p95: 5645 ms

Diagnostica order lane sync:

- `wf=delivered`: 74 sync, wait medio 7781 ms, wait max 13798 ms
- `wf=ready`: 40 sync, wait medio 9681 ms, wait max 14507 ms

## Decisione

Il percorso no-op non e' raro nel mix simulato: nel canary medio intercetta il 22,81% delle sync ordine.

Dato importante: il no-op oggi viene riconosciuto dentro la order lane. Quindi:

- evita revision bump, audit, notifiche, fulfillment history e scritture inutili;
- ma non elimina l'attesa in coda della order lane, perche' la richiesta e' gia' stata accodata.

Il prossimo passo utile non e' un altro micro-fastpath dentro l'handler, ma una verifica/prova per spostare il riconoscimento delle sync terminali duplicate prima della order lane, oppure in una corsia read-only dedicata, mantenendo escluso il write-primary relazionale con CAS.

## Prossimo step consigliato

Implementare una probe guardata da test per `terminal duplicate sync pre-lane`:

1. leggere solo il minimo necessario prima dell'accodamento;
2. validare sessione e ordine senza mutazioni;
3. se e solo se e' duplicata terminale e il write-primary relazionale e' spento, rispondere idempotente senza entrare in order lane;
4. lasciare tutto il resto invariato.

DoD del prossimo step: riduzione misurabile di `orderLaneEnqueued` o delle sync accodate pari almeno all'hit-rate osservato, senza rompere CAS, audit e flussi ready/delivered reali.

