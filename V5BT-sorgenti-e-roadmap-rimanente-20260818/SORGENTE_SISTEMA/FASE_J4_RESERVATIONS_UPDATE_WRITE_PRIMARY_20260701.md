# FASE J4 - reservations/update write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/pos/reservations/update` nel percorso write-primary relazionale, mantenendo il JSON app-state come mirror compatibile durante la migrazione.

## Modifiche

- Aggiunto `ReservationsRelationalRepository.updateReservationWithLock`.
- Aggiunto flag `BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY=1`.
- Agganciato alias rollout `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- L'update ora legge lo stato prenotazioni dal relazionale quando il flag J4 e attivo.
- L'update verifica il lock relazionale attivo con `reservationId`, `lockId`, `userId` e `deviceUuid`.
- La scrittura aggiorna `reservations` e ricostruisce `reservation_table_assignments` nella stessa transazione.
- Dopo la scrittura relazionale, l'app-state JSON viene aggiornato come mirror con la nuova `version`.
- `create/status/delete` restano nel percorso app-state in questa fase.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Prenotazione assente: `404`.
- Lock assente/scaduto: `409`.
- Lock di altro device/utente: `409`.
- Conflitto revisione: `409`.
- `backend/server.js` resta a 40499 righe, sotto il budget architetturale.

## Test eseguiti

- `node --check` su repository, handler, server e test J2/J3/J4: OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 9/9 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 20/20 OK.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs`: 17/17 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.

## Stato

Fase J4 completata. Il ciclo lock acquire/release/update delle prenotazioni e ora coperto dal relazionale, con mirror app-state ancora attivo per compatibilita.
