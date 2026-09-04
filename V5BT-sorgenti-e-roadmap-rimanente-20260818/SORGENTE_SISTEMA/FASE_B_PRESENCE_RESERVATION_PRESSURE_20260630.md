# Fase B - Presenza cameriere e pressione prenotazioni

Data: 2026-06-30

## Obiettivo

Continuare la roadmap realtime riducendo le code residue emerse dopo lo spostamento di `session/status` fuori dalla coda globale:

- pausa cameriere `start/stop` fuori da `dbMutationQueue`;
- heartbeat postazioni sempre prioritario;
- prenotazioni non piu lasciate ultime dietro ordini, pagamenti e spostamenti;
- harness loadtest robusto con run id lunghi.

## Implementato

- `server.js`
  - `POST /api/mobile/waiter-pause/start|stop` passa dalla lane presenza/notifiche, non dalla coda globale;
  - scheduler: `stationStateLane` viene provata subito dopo `notificationLane`;
  - `RESERVATION_LANE_CONCURRENCY` default 2, max 4;
  - `RESERVATION_LANE_PRESSURE_PRIORITY_DEPTH=8`: quando la coda prenotazioni supera la soglia viene anticipata prima della lane sale;
  - mantenuto `server.js` sotto limite hard: 39997 righe.
- `waiters-routing.e2e.test.mjs`
  - aggiunto test che verifica `waiter-pause` su lane presenza e `dbMutationEnqueued=0`.
- `loadtest-full-capacity.mjs`
  - aggiunto `mysqlSafeLoadPrefix()` per evitare identificatori MySQL troppo lunghi con `LOADTEST_RUN_ID` descrittivi.

## Verifiche automatiche

- `node --check cassa-frontend/backend/server.js`
- `node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`
  - 20/20 pass
- `node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs cassa-frontend/backend/tests/auth-session.e2e.test.mjs`
  - 34/34 pass

## Load test 50 palmari / 10 postazioni

Baseline dopo priorita postazioni:

- run: `post_station_priority_50_2026063001`
- durata: 244.6s
- errori campionati: 3
- `station.heartbeat` p95 1689ms, max 2595ms
- `reservation.create` p95 124396ms, max 124644ms
- `payment.free_split` p95 26464ms, 2 failure

Run scelto dopo pressione prenotazioni:

- run: `post_reservation_pressure_50_2026063001`
- durata: 207.2s
- errori campionati: 0
- `station.heartbeat` p95 1568ms, max 2316ms
- `waiter.pause.start` p95 1999ms, max 2082ms
- `waiter.pause.stop` p95 1702ms, max 1854ms
- `order.create` p95 9311ms, max 9970ms
- `reservation.create` p95 38398ms, max 51369ms
- `payment.free_split` p95 15485ms, max 22021ms

Variante scartata:

- run: `post_room_reservation_fair_50_2026063001`
- durata: 213.5s
- errori campionati: 1 (`order.comp`, articolo non trovato)
- migliorava alcuni tempi sala ma peggiorava ordini, pagamenti e prenotazioni;
- patch fairness rimossa.

## Prossimo step consigliato

Affrontare la lane sale/spostamenti senza degradare ordini e pagamenti. Il collo residuo e:

- `room.change.request`, `table.move`, `table.room_move.request` ancora con p95 alto sotto carico artificiale;
- evitare una fairness generica sale/prenotazioni: il tentativo ha reintrodotto un errore su `order.comp`;
- prossimo intervento preferibile: separare/ottimizzare gli spostamenti tavolo per chiave stanza/tavolo e ridurre il tempo di permanenza nella lane, non solo cambiare priorita scheduler.
