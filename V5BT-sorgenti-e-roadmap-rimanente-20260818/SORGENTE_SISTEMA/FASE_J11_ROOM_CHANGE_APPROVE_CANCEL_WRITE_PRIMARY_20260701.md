# FASE J11 - room-change approve/cancel write-primary relazionale

Data: 2026-07-01

## Obiettivo

Completare il ciclo `room-change` portando `POST /api/pos/room-change/approve` e `POST /api/pos/room-change/cancel` nel percorso write-primary relazionale, mantenendo il comportamento legacy di rimozione della richiesta pending.

## Modifiche

- Aggiunto `ReservationsRelationalRepository.deleteRoomChangeRequest`.
- `approve` cancella la richiesta da `room_change_requests` prima di rimuoverla dal mirror app-state.
- `cancel` cancella la richiesta da `room_change_requests` prima di rimuoverla dal mirror app-state.
- Entrambi i percorsi usano `expectedRevision` per intercettare conflitti tra mirror e relazionale.
- Il flag resta `BACKEND_RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY=1`.
- L'alias rollout resta `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- Il comportamento API legacy resta invariato: le richieste approvate o cancellate non restano nella lista pending.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Richiesta mancante nel relazionale: `404`.
- Conflitto revision: `409` con code `ROOM_CHANGE_REQUEST_CONFLICT`.
- `approve` e `cancel` restano protette dal permesso `approve_room_change`.
- `backend/server.js` resta a 40499 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `node --check` su server, repository e test J10/J11: OK.
- `node --test cassa-frontend/backend/tests/relational-room-change-request-write-primary.test.mjs`: 4/4 OK.
- `node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`: 8/8 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.
- `node --test cassa-frontend/backend/tests/table-room-move-domain.test.mjs`: 9/9 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

Fase J11 completata. Il ciclo `room-change/request -> approve/cancel` ora e' coperto dal relazionale in write-primary per le richieste pending, con mirror app-state coerente. Il prossimo passo naturale e' applicare lo stesso schema a `table-room-move/request`, poi a `table-room-move/resolve`.
