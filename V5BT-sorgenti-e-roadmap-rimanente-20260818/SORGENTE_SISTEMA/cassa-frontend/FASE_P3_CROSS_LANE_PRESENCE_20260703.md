# Fase P3 - Cross-lane presence canary

Data: 2026-07-03

## Obiettivo

Continuare il Passo 3 di `ROADMAP_INTERINALE_P3_LATENZA.md` dopo il pre-lane
delle sync terminali: verificare se il collo residuo della `order lane` era
amplificato dai blocchi cross-domain e, soprattutto, proteggere heartbeat
postazioni e pause cameriere quando L1/L2/L3 sono aperte.

## Diagnosi

Il canary con L1/L2/L3 aperti ha confermato che la latenza ordini migliora
molto rispetto al canary pre-lane conservativo, ma ha spostato il problema sulle
corsie presence:

- `station.heartbeat` p95: 1667 ms -> 9236 ms.
- `waiter.pause.start` p95: 3373 ms -> 19765 ms.
- `waiter.pause.stop` p95: 3242 ms -> 22204 ms.

Il tentativo di aumentare solo il burst presence a 32 non ha risolto:

- `station.heartbeat` p95: 17968 ms.
- `waiter.pause.start` p95: 19106 ms.
- `waiter.pause.stop` p95: 18253 ms.

Quindi il collo non era solo il burst cap, ma il fatto che `stationStateLane` e
`waiterPauseLane` restavano bloccate da room/reservation/notification.

## Modifica

Aggiunto flag canary conservativo:

```env
LANE_CROSS_EXCLUSION_PRESENCE=0
```

Default: `1`, quindi senza flag il comportamento resta invariato.

Con il flag a `0`:

- room/reservation/notification possono ignorare `waiterPauseLane` e
  `stationStateLane`;
- `waiterPauseLane` e `stationStateLane` possono ignorare
  room/reservation/notification;
- `paymentLane` resta governata da `LANE_CROSS_EXCLUSION_PAYMENTS`;
- `dbMutationQueue` resta esclusiva;
- order lane continua a non ignorare station state direttamente: non e' stato
  allargato piu' del necessario.

Guardrail aggiunti in `route-policy-architecture.test.mjs` come Fase L4.

## Verifiche

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs cassa-frontend/backend/tests/station-availability-alerts.e2e.test.mjs cassa-frontend/backend/tests/table-structure-updates.e2e.test.mjs cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs
```

Risultati:

- Architettura + runtime metrics: 48/48 pass.
- Suite funzionale mirata: 47/47 pass.
- `server.js`: 38.792 righe, margine M5 preservato.

## Canary

### Baseline pre-lane conservativa

Run: `phaseP_interinale_p3_terminal_prelane_canary12_50`

- Failure: 0
- `order.create` p95: 17691 ms
- `order.sync.ready` p95: 13360 ms
- `order.sync.delivered` p95: 17522 ms
- `order.correct` p95: 18081 ms
- `station.heartbeat` p95: 1667 ms
- `waiter.pause.start` p95: 3373 ms
- `waiter.pause.stop` p95: 3242 ms
- `payment.free_split` p95: 9882 ms
- `reservation.create` p95: 7521 ms

### L1/L2/L3 aperti

Run: `phaseP_interinale_p3_crosslane_canary12_50`

- Failure: 0
- `crossDomainConcurrencyFamiliesActiveMax`: 4
- `order.create` p95: 11514 ms
- `order.sync.ready` p95: 11124 ms
- `order.sync.delivered` p95: 10564 ms
- `order.correct` p95: 10785 ms
- `station.heartbeat` p95: 9236 ms
- `waiter.pause.start` p95: 19765 ms
- `waiter.pause.stop` p95: 22204 ms
- `payment.free_split` p95: 2561 ms
- `reservation.create` p95: 4203 ms

### L1/L2/L3 + burst presence 32

Run: `phaseP_interinale_p3_crosslane_presenceburst_canary12_50`

- Failure: 0
- `station.heartbeat` p95: 17968 ms
- `waiter.pause.start` p95: 19106 ms
- `waiter.pause.stop` p95: 18253 ms

Decisione: respinto. Non corregge la presence lane.

### L1/L2/L3/L4 aperti

Run: `phaseP_interinale_p3_crosslane_presence_canary12_50`

- Failure: 0
- Retry/deadlock/lock wait nei log: 0
- `crossDomainConcurrencyFamiliesActiveMax`: 5
- `order.create` p95: 12759 ms
- `order.sync.ready` p95: 11673 ms
- `order.sync.delivered` p95: 11766 ms
- `order.correct` p95: 11010 ms
- `order.comp` p95: 8632 ms
- `station.heartbeat` p95: 1266 ms
- `waiter.pause.start` p95: 4987 ms
- `waiter.pause.stop` p95: 4859 ms
- `payment.free_split` p95: 4829 ms
- `reservation.create` p95: 3085 ms
- `table.room_move.request` p95: 2747 ms

### L1/L2/L3/L4 conferma 2

Run: `phaseP_interinale_p3_crosslane_presence_confirm2_50`

- Durata: 98 s
- Operazioni business: 720
- Richieste HTTP: 1776
- Failure: 0
- Retry/deadlock/lock wait/timeout nei log del run: 0
- RT fiscale reale: 0 tentativi
- `crossDomainConcurrencyFamiliesActiveMax`: 5
- `order.create` p95: 12245 ms
- `order.sync.ready` p95: 11335 ms
- `order.sync.delivered` p95: 11958 ms
- `order.correct` p95: 13063 ms
- `order.comp` p95: 5455 ms
- `station.heartbeat` p95: 2173 ms
- `station.states.get` p95: 175 ms
- `order.refresh` p95: 370 ms
- `orders.poll` p95: 193 ms
- `payment.free_split` p95: 4229 ms
- `reservation.create` p95: 1930 ms
- `table.room_move.request` p95: 5236 ms
- `room.change.request` p95: 4452 ms
- `waiter.pause.start` p95: 3221 ms
- `waiter.pause.stop` p95: 4915 ms
- `orderLane` wait p95 max: 12502 ms

## Decisione

Promosso come configurazione canary P4, non ancora come default runtime:

- L4 risolve la regressione presence introdotta dall'apertura L1/L2/L3.
- Mantiene 0 failure e nessun retry/deadlock osservato in due canary
  consecutivi L1/L2/L3/L4.
- Gli ordini restano molto migliori del pre-lane conservativo, anche se un po'
  peggiori del cross-lane senza L4.
- Il gate P3 resta non chiuso: `order.create`/`order.sync` sono ancora intorno a
  11-13 secondi p95, lontani dalla soglia intermedia 500 ms.

## Prossimo step

La configurazione P4 dovra' includere:

```env
LANE_CROSS_EXCLUSION_ORDERS=0
LANE_CROSS_EXCLUSION_TABLES=0
LANE_CROSS_EXCLUSION_PAYMENTS=0
LANE_CROSS_EXCLUSION_PRESENCE=0
```

Il prossimo lavoro P3 torna sulla causa rimasta: costo/attesa della
`order lane`, in particolare `orders.create.mysql.orders`,
`orders.sync.mysql.orders`, `auditRecent` e il tempo di wait della lane nei
burst a 50 device.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_crosslane_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_crosslane_presenceburst_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_crosslane_presence_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_crosslane_presence_confirm2_50/report.json`
