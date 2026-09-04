# Fase J3 - Reservations Lock Release Write-Primary Relazionale

Data: 2026-07-01

## Obiettivo

Completare il lifecycle base del lease prenotazioni portando anche il rilascio lock sul relazionale.

## Implementazione

- Aggiunto flag:
  - `BACKEND_RELATIONAL_RESERVATIONS_LOCK_RELEASE_WRITE_PRIMARY=1`
  - alias ampio: `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`
- Aggiunto metodo atomico `ReservationsRelationalRepository.releaseReservationLock`.
- Il comando `POST /api/pos/reservations/lock/release` quando il flag e' attivo:
  - elimina il lock relazionale solo se `reservationId`, `lockId`, `userId` e `deviceUuid` corrispondono;
  - rimuove lock scaduti dal relazionale e risponde `released:false`;
  - non rimuove lock attivi di altri device, rispondendo `released:false`;
  - aggiorna il mirror app-state quando il lock viene rilasciato o potato per scadenza.
- Se il flag e' acceso ma il DB relazionale non e' disponibile, risponde `503` chiaro.

## Guardrail

- `lock/acquire` e `lock/release` sono write-primary relazionali; update/status/delete prenotazione restano app-state.
- Il comportamento HTTP resta compatibile: release non valida/non proprietaria torna `200 released:false`, come il vecchio percorso.
- `server.js` resta a 40499 righe.

## Test eseguiti

- `node --check cassa-frontend/backend/db/relational/reservations.repo.js`
- `node --check cassa-frontend/backend/modules/reservations/reservations.handlers.js`
- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs` -> 6/6 pass.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 20/20 pass.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs` -> 17/17 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53/53 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1/1 pass.

## Prossimo step

Procedere con J4. Due candidati possibili:

- `reservations/update` write-primary con lock relazionale completo;
- `tables/lock/acquire` write-primary per aprire il percorso lock tavoli.

La scelta piu' conservativa e' `reservations/update`, per usare subito il lifecycle lock prenotazioni appena completato.
