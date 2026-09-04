# Fase B - Rooms/Table Move Lane

Data: 2026-06-30

## Obiettivo

Portare cambio sala e spostamenti tavolo/sala fuori dalla coda globale DB, mantenendo la serializzazione sugli aggregati coinvolti.

## Implementato

- Nuova lane `roomLane` per:
  - `POST /api/pos/room-change/request`
  - `POST /api/pos/room-change/approve`
  - `POST /api/pos/room-change/cancel`
  - `POST /api/integration/layout/table/sync`
  - `POST /api/integration/layout/table/move`
  - `POST /api/integration/layout/table/room-move/request`
  - `POST /api/integration/layout/table/room-move/status`
  - `POST /api/integration/layout/table/room-move/pending`
  - `POST /api/integration/layout/table/room-move/resolve`
- Flag rollout:
  - `LANE_ROOMS=1`
  - `ROOM_LANE_ENABLED=0` per disattivare
  - `ROOM_LANE_CONCURRENCY=2` nello script di riavvio
- La lane si attiva solo con MySQL + `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1`.
- Chiavi multi-aggregato:
  - `request:<requestId>` per approvazioni/cancel/status/resolve
  - `table:<tableId>` per sync tavolo
  - `table:<fromTableId>` + `table:<toTableId>` per move tavolo
  - target tables + `room:<targetRoomId>` per room-move request
  - `room:<roomId>` per pending room-move
  - `room:<targetRoomId>` + `user:<user/device/session>` per room-change request.
- Nuova `writeRoomDb()` con domini mirati:
  - `sessions`
  - `integration`
  - `posSettings`
  - `posRoomChangeRequests`
  - `posTableRoomMoveRequests`
  - `posReservationStates`
  - `posReservationLocks`
  - `auditEvents`
  - `printSpoolJobs`
  - `tableLocks`
- Metriche runtime aggiunte:
  - `roomLaneEnqueued`
  - `queues.roomLane.waitMsByLabel`
  - `queues.roomLane.runMsByLabel`
  - `roomLaneDepth`
  - `roomLaneRunning`

## Fix emerso dai test

La security suite ha evidenziato che dopo `/api/integration/layout/table/move` il tavolo sorgente poteva tornare `no_orders` invece di `free` dopo la risincronizzazione finanziaria. Ora il sorgente appena svuotato viene riaffermato come libero dopo il sync.

## Guard rail

- La room lane resta esclusiva rispetto a coda globale, order lane e payment lane.
- Dentro la room lane, operazioni con chiavi tavolo/room diverse possono procedere in parallelo.
- Operazioni che condividono almeno una chiave tavolo/request/room non partono insieme.
- Le route senza chiave utile ricadono sulla coda globale.

## Verifiche

Comandi eseguiti con Node locale:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/modules/runtime-metrics.js`
- `bash -n tools/restart-cassav4-linux.sh`
- `node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/table-room-move-domain.test.mjs`
- `node --test cassa-frontend/backend/tests/table-structure-updates.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`
- `node --test cassa-frontend/backend/tests/security.test.mjs`

Risultato finale:

- Syntax check OK.
- Waiters routing: 7/7 pass.
- Table room move domain: 9/9 pass.
- Table structure updates: 4/4 pass.
- Route/security architecture: 7/7 pass.
- Orders/payments invariants: 16/16 pass.
- Security e2e: 29/29 pass dopo il fix sul tavolo sorgente.

## Prossimo step consigliato

Procedere con B-reservations:

- lane dedicata per `/api/pos/reservations/*`;
- chiavi `reservation:<reservationId>`, `room:<roomId>:<serviceDate>`, `table:<tableId>`;
- `writeReservationDb()` con domini `posReservations`, `posReservationStates`, `posReservationLocks`, `posSettings`, `integration`, `auditEvents`.
