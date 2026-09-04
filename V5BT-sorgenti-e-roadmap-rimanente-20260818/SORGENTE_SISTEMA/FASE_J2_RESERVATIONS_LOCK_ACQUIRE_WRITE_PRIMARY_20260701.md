# Fase J2 - Reservations Lock Acquire Write-Primary Relazionale

Data: 2026-07-01

## Obiettivo

Spostare il primo comando isolato del dominio prenotazioni sul relazionale: acquisizione/refresh del lock di modifica prenotazione.

## Implementazione

- Aggiunto flag:
  - `BACKEND_RELATIONAL_RESERVATIONS_LOCK_ACQUIRE_WRITE_PRIMARY=1`
  - alias ampio: `RESERVATIONS_RELATIONAL_WRITE_PRIMARY=1`
- Aggiunto metodo atomico `ReservationsRelationalRepository.acquireReservationLock`.
- Il comando `POST /api/pos/reservations/lock/acquire` quando il flag e' attivo:
  - verifica che la prenotazione esista nel relazionale;
  - accetta refresh dello stesso `userId/deviceUuid`;
  - rifiuta un lock attivo di altro device con `409`;
  - scrive `reservation_locks` nel relazionale;
  - copia il lock in app-state come mirror compatibile con i client attuali.
- Se il flag e' acceso ma il DB relazionale non e' disponibile, risponde errore chiaro `503` invece di fare fallback silenzioso.

## Guardrail

- Solo `lock/acquire` e' write-primary; release/update/status/delete restano app-state.
- Il mirror app-state resta attivo per compatibilita' e per la sync shadow.
- La `revision` del lock e' gestita dal relazionale durante l'acquire, ma il ciclo completo CAS del lock andra' consolidato quando anche release/update saranno relazionali.
- `server.js` resta a 40499 righe.

## Test eseguiti

- `node --check cassa-frontend/backend/db/relational/reservations.repo.js`
- `node --check cassa-frontend/backend/modules/reservations/reservations.handlers.js`
- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs`
- `node --test cassa-frontend/backend/tests/relational-reservations-lock-write-primary.test.mjs` -> 3/3 pass.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 20/20 pass.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs` -> 17/17 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53/53 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1/1 pass.

## Prossimo step

Procedere con J3:

- opzione A: `reservations/lock/release` write-primary, per chiudere il ciclo del lease prenotazioni;
- opzione B: `tables/lock/acquire` write-primary, per iniziare il percorso dei lock tavolo.

La scelta piu' lineare e' A, per completare prima il lifecycle lock prenotazioni.
