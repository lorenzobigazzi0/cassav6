# Fase B - Lane fairness e room request realtime

Data: 2026-07-01

## Obiettivo

Riprendere il lavoro sulla roadmap realtime dopo lo stop manuale, verificando il fix su:

- `room.change.request`;
- `table.room_move.request`;
- `table.move` con preflight veloce;
- code residue su pagamenti e prenotazioni.

## Modifiche

- `POST /api/pos/room-change/request` e `POST /api/integration/layout/table/room-move/request` restano su `notificationLane`, non sulla `roomLane`.
- `POST /api/integration/layout/table/move` ha preflight veloce per rifiutare operazioni gia impossibili senza entrare nella room lane.
- Corretto `mysqlSafeLoadPrefix()` nello script di load test: i run id lunghi ora usano hash SHA1 e non collidono sui nomi tabella MySQL.
- Aggiunta fairness scheduler:
  - `PAYMENT_LANE_PRESSURE_PRIORITY_DEPTH=4`;
  - `RESERVATION_LANE_PRESSURE_PRIORITY_DEPTH=3`;
  - sotto pressione, pagamenti e prenotazioni passano prima del successivo burst ordini.
- Aggiunto test di policy per evitare regressioni sulla priorita di pagamenti/prenotazioni.

## Test automatici

Passati:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/scripts/loadtest-full-capacity.mjs`
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs cassa-frontend/backend/tests/table-structure-updates.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs`

## Load test

### 25 palmari / 5 postazioni

Run: `post_lane_fairness_hash25_2026070101`

- Durata: 67s
- Business ops: 360
- Failure: 0
- `order.create` p95: 4922ms
- `payment.free_split` p95: 12699ms
- `reservation.create` p95: 7173ms
- `table.room_move.request` p95: 889ms
- `room.change.request` p95: 524ms
- `table.move` p95: 69ms
- `login` p95: 158ms

Confronto immediato con run pulito precedente `post_room_request_notify_hash25_2026070101`:

- durata 94s -> 67s;
- failure 0 -> 0;
- `reservation.create` p95 38319ms -> 7173ms;
- `order.create` p95 6996ms -> 4922ms;
- `payment.free_split` p95 15416ms -> 12699ms;
- room request resta sotto circa 1.2s.

### 50 palmari / 10 postazioni

Run: `post_lane_fairness_50_2026070101`

- Durata: 140s
- Business ops: 720
- Failure: 0
- `login` p95: 152ms
- `station.heartbeat` p95: 1122ms
- `room.change.request` p95: 2216ms
- `table.room_move.request` p95: 3319ms
- `table.move` p95: 409ms, max outlier 34559ms
- `payment.free_split` p95: 10268ms
- `reservation.create` p95: 21506ms, max outlier 39577ms
- `order.create` p95: 16200ms
- `order.sync.ready` p95: 16396ms
- `order.sync.delivered` p95: 16409ms

Confronto con `post_room_request_notify_50_2026063001`:

- durata 245s -> 140s;
- failure 1 -> 0;
- `payment.free_split` p95 51937ms -> 10268ms;
- `reservation.create` p95 118810ms -> 21506ms;
- `room.change.request` resta nell'ordine dei secondi e non piu decine di secondi.

## Decisione

La fase e' stabile e migliorativa. Restano code fisiologiche della `orderLane` sotto 50 device: il run mostra backlog di 35-50 richieste con esecuzione singola breve ma attesa alta. Il prossimo intervento utile non e' altra priorita nello scheduler, ma ridurre il tempo e il volume degli update ordine puntuali, come gia indicato nella roadmap DB: portare `create/sync/correct/comp` verso repository SQL/domain update piu piccoli per `orderId`.

## Prossimo step consigliato

Aprire una fase dedicata a `orderLane`:

- misurare quali handler ordine scrivono piu dati;
- separare sync ready/delivered da create/correct quando possibile;
- spostare le scritture ordine ripetitive su update puntuali per ordine/station invece di riscrivere porzioni grandi del dominio `integration`;
- mantenere preflight 409 fuori dalla lane.
