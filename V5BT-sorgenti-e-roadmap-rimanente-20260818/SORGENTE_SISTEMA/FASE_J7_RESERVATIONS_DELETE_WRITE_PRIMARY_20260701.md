# FASE J7 - reservations/delete write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/pos/reservations/delete` nel percorso write-primary relazionale, mantenendo app-state JSON come mirror compatibile.

## Modifiche

- Aggiunto `ReservationsRelationalRepository.deleteReservationWithLock`.
- Aggiunto flag `BACKEND_RELATIONAL_RESERVATIONS_DELETE_WRITE_PRIMARY=1`.
- Agganciato alias rollout `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- Il delete verifica nel relazionale `reservationId`, `lockId`, `userId` e `deviceUuid`.
- La cancellazione rimuove `reservation_locks`, `reservation_table_assignments` e `reservations` nella stessa transazione.
- Il mirror app-state rimuove la prenotazione e il lock JSON legacy.
- Il percorso legacy resta invariato quando il flag e spento.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Prenotazione assente: `404`.
- Lock assente/scaduto: `409`.
- Lock di altro device/utente: `409`.
- Conflitto revisione: `409`.
- `backend/server.js` resta a 40499 righe, sotto il budget architetturale.

## Test eseguiti

- `node --check` su repository, handler, server e test J2/J3/J4/J5/J6/J7: OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 18/18 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 20/20 OK.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs`: 17/17 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.

## Stato

Fase J7 completata. Il sotto-dominio prenotazioni ora copre read-primary, create, lock acquire/release, update, status e delete sul relazionale con mirror app-state.
