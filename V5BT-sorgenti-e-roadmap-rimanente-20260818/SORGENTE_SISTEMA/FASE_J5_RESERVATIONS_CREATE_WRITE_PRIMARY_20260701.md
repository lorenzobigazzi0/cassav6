# FASE J5 - reservations/create write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/pos/reservations/create` e `POST /api/public/reservations/create` nel percorso write-primary relazionale, mantenendo app-state JSON come mirror compatibile.

## Modifiche

- Aggiunto `ReservationsRelationalRepository.createReservation`.
- Aggiunto flag `BACKEND_RELATIONAL_RESERVATIONS_CREATE_WRITE_PRIMARY=1`.
- Agganciato alias rollout `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`.
- La creazione calcola la prossima `revision` per `roomId` + `serviceDate`.
- La scrittura relazionale inserisce `reservations` e `reservation_table_assignments` nella stessa transazione.
- La validazione disponibilita tavolo usa lo stato relazionale quando il flag J5 e attivo.
- Il mirror app-state riallinea le prenotazioni gia lette dal relazionale prima di scrivere il JSON.
- Il percorso update J4 usa lo stesso helper di mirror, senza cambiare il contratto di risposta legacy.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- ID prenotazione gia presente: `409`.
- Disponibilita tavolo non rispettata: `409` prima della scrittura.
- `backend/server.js` resta a 40499 righe, sotto il budget architetturale.

## Test eseguiti

- `node --check` su repository, handler, server e test J2/J3/J4/J5: OK.
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`: 12/12 OK.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 20/20 OK.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs`: 17/17 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.

## Stato

Fase J5 completata. Il dominio prenotazioni ora copre read-primary, lock acquire/release, update e create sul relazionale con mirror app-state.
