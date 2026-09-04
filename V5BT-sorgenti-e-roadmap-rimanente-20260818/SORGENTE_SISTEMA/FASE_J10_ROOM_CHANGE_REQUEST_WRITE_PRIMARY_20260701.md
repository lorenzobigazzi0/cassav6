# FASE J10 - room-change/request write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/pos/room-change/request` nel percorso write-primary relazionale per il ramo pending, mantenendo app-state JSON come mirror compatibile.

## Modifiche

- Aggiunto flag `BACKEND_RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY=1`.
- Agganciato alias rollout `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- Aggiunto `ReservationsRelationalRepository.getRoomChangeRequest`.
- Aggiunto `ReservationsRelationalRepository.createRoomChangeRequest`.
- `sanitizePosRoomChangeRequestRecord` preserva `revision`.
- Il ramo pending crea la richiesta in `room_change_requests` prima del write app-state.
- Il mirror app-state conserva la richiesta con `revision=1`.
- Il ramo diretto approvato resta invariato e non crea richieste.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Richiesta incompleta: `400`.
- Doppio `requestId`: `409`.
- Il percorso legacy resta invariato quando il flag e' spento.
- `backend/server.js` resta a 40499 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `node --check` su server, repository e test J10: OK.
- `node --test cassa-frontend/backend/tests/relational-room-change-request-write-primary.test.mjs`: 2/2 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`: 8/8 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.
- `node --test cassa-frontend/backend/tests/table-room-move-domain.test.mjs`: 9/9 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

Fase J10 completata. `room-change/request` ora scrive il ramo pending su `room_change_requests` in write-primary relazionale con revision iniziale e mirror app-state. Il prossimo passo naturale e' portare `room-change/approve` e `room-change/cancel` sul relazionale, cosi' il ciclo della richiesta cambio sala diventa completo.
