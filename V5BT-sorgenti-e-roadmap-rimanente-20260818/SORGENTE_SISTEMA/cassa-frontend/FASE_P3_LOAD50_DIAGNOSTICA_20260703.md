# Fase P3 - Scala virtuale load-50 diagnostica

Data: 2026-07-03

## Esito

P3 avviata ma non completata.

Il profilo `load-50` ha esposto saturazione persistente della `order-lane`.
I run sono stati interrotti manualmente per evitare di marcare verde un sistema
che stava ancora accumulando attese operative troppo alte.

Profilo usato:

- 50 palmari API
- 10 postazioni API
- 3 GUI reali Playwright headless
- 70 operazioni per device
- fiscale su mock locale `http://127.0.0.1:9290`
- stampante TCP virtuale su `127.0.0.1:9109`
- stampa fisica disabilitata

## Tentativi

### `phaseP_load-50-p3`

- Interrotto per saturazione order-lane.
- `order-lane`: 652 attese lunghe, media 52831 ms, max 168687 ms, coda max 59.
- `room-lane`: 4 attese lunghe, media 3024 ms, max 4654 ms.
- Eventi transient/deadlock/retry loggati: 15.

### `phaseP_load-50-p3-fixed`

Dopo priorita' room-lane e priorita/concurrency order-lane.

- Interrotto per saturazione order-lane ancora presente.
- `order-lane`: 888 attese lunghe, media 33802 ms, max 61724 ms, coda max 63.
- `room-lane`: 2 attese lunghe, media 4067 ms, max 5238 ms.
- Eventi transient/deadlock/retry loggati: 11.

### `phaseP_load-50-p3-refill`

Dopo refill continuo degli slot order-lane.

- Interrotto per saturazione order-lane ancora presente.
- `order-lane`: 911 attese lunghe, media 33757 ms, max 68349 ms, coda max 63.
- `room-lane`: 6 attese lunghe, media 3575 ms, max 6500 ms.
- Eventi transient/deadlock/retry loggati: 10.

## Correzioni applicate durante P3

- Aggiunta soglia `ROOM_LANE_PRESSURE_PRIORITY_DEPTH` per dare priorita' ai trasferimenti tavolo prima di aprire nuovi burst ordini.
- Aggiunto guardrail statico `room lane gets pressure priority before new order bursts`.
- `ORDER_SYNC_FAST_LANE_CONCURRENCY` portata da default 4/cap 4 a default 6/cap 8.
- `orderSyncLaneTaskPriority` ora tratta `orders/create` come workflow live (`2`) e tiene la station reconciliation dietro (`4`).
- L'order-lane ora ricarica gli slot liberi mentre altri worker della stessa lane sono ancora attivi, invece di lavorare solo a ondate complete.

## Verifiche

- `node --check cassa-frontend/backend/server.js`: ok
- `node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs`: ok
- test mirati P/architettura: 27/27 pass
- Nessun processo loadtest/backend/frontend/mock rimasto attivo al termine.

## Diagnosi

La correzione della `room-lane` ha risolto il collo evidente di P2: i
`table.move` non risultano piu' bloccati per minuti.

Il nuovo limite e' `orders/create`/`orders/sync` sotto `load-50`: anche con
priorita' live, concurrency 6 e refill continuo, la coda order-lane rimane
attorno a 50-60 e l'attesa torna sopra 30-60 secondi. La causa da lavorare nel
prossimo step non sembra piu' lo scheduler di priorita', ma il costo della
singola mutazione ordine sotto MySQL/app-state split e auto-print.

## Prossimo step

Continuare P3 senza salire a `load-100`.

Obiettivi immediati:

- misurare il tempo interno di `orders/create` separando app-state write,
  relational write-primary, auto-print enqueue e cache refresh;
- ridurre il costo della mutazione ordine o spostare fuori dalla corsia live il
  lavoro non indispensabile;
- rilanciare `phaseP_load-50` solo quando la coda order-lane non resta stabile
  sopra 50 sotto carico.

Aggiornamento successivo:

- lo step di strumentazione e' documentato in
  `FASE_P3_ORDER_WORKFLOW_METRICS_20260703.md`;
- il prossimo `load-50` deve leggere le nuove tabelle runtime
  `app-state write per label` e `operations`.
