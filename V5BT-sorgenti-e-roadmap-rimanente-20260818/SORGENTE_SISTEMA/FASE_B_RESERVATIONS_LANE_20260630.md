# Fase B - Reservations Lane

Data: 2026-06-30

## Obiettivo

Portare le mutazioni delle prenotazioni fuori dalla coda globale DB, mantenendo ordine e coerenza su stato prenotazioni, lock, tavoli e audit.

## Implementato

- Nuova lane `reservationLane` per:
  - `POST /api/public/reservations/create`
  - `POST /api/pos/reservations/create`
  - `POST /api/pos/reservations/lock/acquire`
  - `POST /api/pos/reservations/lock/release`
  - `POST /api/pos/reservations/update`
  - `POST /api/pos/reservations/status`
  - `POST /api/pos/reservations/delete`
  - `POST /api/pos/reservations/availability`
  - `POST /api/pos/reservations/lock/state`
- Flag rollout:
  - `LANE_RESERVATIONS=1`
  - `RESERVATION_LANE_ENABLED=0` per disattivare
  - `RESERVATION_LANE_CONCURRENCY=1` nello script di riavvio
- La lane si attiva solo con MySQL + `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1`.
- Chiavi multi-aggregato:
  - `reservation:<reservationId>` per modifica, stato, delete e lock.
  - `reservation-lock:<reservationId>:<lockId>` per operazioni lock.
  - `reservation-room:<roomId>:<serviceDate>` per creare/validare prenotazioni nello stesso turno sala.
  - `table:<tableId>` quando la richiesta contiene tavoli assegnati o candidati.
  - fallback per route/device/user quando non ci sono identificativi utili.
- Nuova `writeReservationDb()` con domini mirati:
  - `posReservationStates`
  - `posReservationLocks`
  - `posReservations`
  - `posSettings`
  - `integration`
  - `auditEvents`
  - `tableLocks`
- Metriche runtime aggiunte:
  - `reservationLaneEnqueued`
  - `queues.reservationLane.waitMsByLabel`
  - `queues.reservationLane.runMsByLabel`
  - `reservationLaneDepth`
  - `reservationLaneRunning`

## Guard rail

- La reservation lane resta esclusiva rispetto a coda globale, order lane, payment lane e room lane.
- Concorrenza interna fissata a 1: oggi `posReservationStates` e `posReservationLocks` sono ancora domini JSON interi in `app_state_domain_records`, quindi il parallelismo per singola prenotazione verra riaperto solo dopo uno split row-level dedicato.
- La creazione pubblica e stata inclusa per evitare che una prenotazione dal frontend pubblico blocchi la coda globale.
- Le route `list` pubblica/autenticata restano read-only e non passano dalla lane.

## Verifiche

Comandi eseguiti con Node locale:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/modules/runtime-metrics.js`
- `bash -n tools/restart-cassav4-linux.sh`
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs`
- `node --test cassa-frontend/backend/tests/reservations-status.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs`
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Risultato finale:

- Syntax check OK.
- Reservations domain: 11/11 pass.
- Reservations status e2e: 3/3 pass.
- Reservations multi-table static: 3/3 pass.
- Route/security architecture: 7/7 pass.
- Runtime metrics: 1/1 pass, con verifica dello snapshot `reservationLane`.

## Prossimo step consigliato

Procedere con B-notifications:

- lane dedicata o fast path per publish/ack/pull notifiche;
- priorita alta per comanda pronta e chiamata cameriere;
- metriche dedicate su latenza publish -> consegna SSE/pull;
- test con target non disponibile e fallback verso utenti online.
