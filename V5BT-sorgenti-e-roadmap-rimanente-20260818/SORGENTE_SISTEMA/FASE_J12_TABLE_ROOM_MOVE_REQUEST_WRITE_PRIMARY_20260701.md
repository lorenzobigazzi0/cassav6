# FASE J12 - table-room-move/request write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/integration/layout/table/room-move/request` nel percorso write-primary relazionale per il ramo pending, mantenendo notifiche, deferred waiter e mirror app-state compatibili.

## Modifiche

- Aggiunto flag `BACKEND_RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY=1`.
- Agganciato alias rollout `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- Aggiunto `ReservationsRelationalRepository.getTableRoomMoveRequest`.
- Aggiunto `ReservationsRelationalRepository.createTableRoomMoveRequest`.
- `sanitizePosTableRoomMoveRequestRecord` preserva `revision`.
- Il ramo pending crea la richiesta in `table_room_move_requests` prima di aggiornare mirror e notifiche.
- Il ramo diretto approvato resta invariato e non crea richieste pending.
- Il mirror app-state conserva la richiesta con `revision=1`.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Richiesta incompleta: `400`.
- Doppio `requestId`: `409`.
- Notifiche `table_room_move_request` e deferred waiter restano prodotte dopo la scrittura relazionale.
- `backend/server.js` resta a 40498 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `node --check` su server, repository, dominio table-room-move e test J12: OK.
- `node --test cassa-frontend/backend/tests/relational-table-room-move-request-write-primary.test.mjs`: 2/2 OK.
- `node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`: 8/8 OK.
- `node --test cassa-frontend/backend/tests/table-room-move-domain.test.mjs`: 9/9 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/relational-room-change-request-write-primary.test.mjs`: 4/4 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

Fase J12 completata. `table-room-move/request` ora scrive il ramo pending su `table_room_move_requests` in write-primary relazionale con mirror app-state coerente. Il prossimo passo naturale e' portare `table-room-move/status`, `pending` e `resolve` sul relazionale, chiudendo il ciclo completo dello spostamento tavolo tra sale.
