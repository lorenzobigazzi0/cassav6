# FASE J6 - reservations/status write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/pos/reservations/status` nel percorso write-primary relazionale, mantenendo app-state JSON come mirror compatibile e senza anticipare il cutover relazionale dei tavoli.

## Modifiche

- Aggiunto `ReservationsRelationalRepository.updateReservationStatus`.
- Aggiunto flag `BACKEND_RELATIONAL_RESERVATIONS_STATUS_WRITE_PRIMARY=1`.
- Agganciato alias rollout `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- Lo status aggiorna `reservations` con CAS su `revision`.
- Il lease `reservation_locks` viene verificato nel relazionale: lock attivo di altro device blocca la mutazione.
- Dopo status valido, il lock relazionale della prenotazione viene rimosso.
- Il mirror app-state riallinea la prenotazione e rimuove il lock JSON legacy.
- `applyPosReservationStatusToAssignedTables` resta lato app-state per preservare il comportamento tavoli finche il dominio tavoli non viene migrato.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Prenotazione assente: `404`.
- Lock attivo di altro device/utente: `409`.
- Conflitto revisione: `409`.
- Stato non valido: `400`.
- `backend/server.js` resta a 40499 righe, sotto il budget architetturale.

## Test eseguiti

- `node --check` su repository, handler, server e test J2/J3/J4/J5/J6: OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 15/15 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 20/20 OK.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs`: 17/17 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.

## Stato

Fase J6 completata. Il dominio prenotazioni ora copre read-primary, create, lock acquire/release, update e status sul relazionale con mirror app-state.
