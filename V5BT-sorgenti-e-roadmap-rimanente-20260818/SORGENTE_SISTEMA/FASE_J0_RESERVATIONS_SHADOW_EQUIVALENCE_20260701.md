# Fase J0 - Reservations Shadow Equivalence

Data: 2026-07-01

## Obiettivo

Portare prenotazioni, lock prenotazioni, richieste cambio sala e richieste spostamento tavolo dentro il DB relazionale in modalita shadow, senza cambiare il comportamento live degli handler.

## Modifiche

- Aggiunta migration `012_reservations` con:
  - `reservations`
  - `reservation_table_assignments`
  - `reservation_locks`
  - `room_change_requests`
  - `table_room_move_requests`
- Aggiunto repository relazionale `ReservationsRelationalRepository`.
- Aggiunto mapper `buildReservationsRelationalRows(appState)`.
- Aggiunta sync `syncReservationsFromAppState`.
- Collegato il dominio `reservations` a:
  - runtime shadow `syncAfterAppStateWrite`
  - `relational_sync_state`
  - equivalenza app-state/relazionale
  - normalizzazione domini di persistenza
- Aggiunti test specifici per il dominio prenotazioni.
- Aggiornati i test con lista migrazioni da `011` a `012`.

## Guardrail

- Nessuna modifica a `server.js`.
- `server.js` resta a 40499 righe.
- I lock prenotazione orfani vengono ignorati nella sync shadow per non rompere la scrittura app-state.
- Il dominio resta shadow: non e' stato abilitato read-primary o write-primary per le prenotazioni.

## Test eseguiti

- `node --check` su nuovi moduli relazionali e file runtime modificati.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs` -> 6/6 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 12/12 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53/53 pass.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs` -> 6/6 pass.
- `node --test cassa-frontend/backend/tests/relational-persistence-mode.test.mjs` -> 9/9 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1/1 pass.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs` -> 17/17 pass.

## Prossimo step

Proseguire con la fase J successiva della roadmap: valutare quali handler prenotazioni possono passare da shadow a write-primary con CAS/revisione, mantenendo prima equivalenza e rollback app-state.
