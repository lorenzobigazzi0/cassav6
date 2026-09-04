# Fase J1 - Reservations Read-Primary Relazionale

Data: 2026-07-01

## Obiettivo

Abilitare una lettura read-primary opzionale e reversibile per endpoint read-only delle prenotazioni, lasciando tutte le scritture ancora su app-state.

## Implementazione

- Aggiunto flag:
  - `BACKEND_RELATIONAL_RESERVATIONS_READS=1`
- Gli endpoint leggono dal relazionale quando il flag e' attivo e il runtime relazionale e' disponibile:
  - `POST /api/pos/reservations/list`
  - `POST /api/pos/reservations/availability`
  - `POST /api/pos/reservations/lock/state`
  - endpoint pubblici list/availability riusano lo stesso lettore.
- In caso di errore o DB relazionale non disponibile, il codice torna al percorso app-state precedente e logga:
  - `[reservations] read-primary relazionale fallback: ...`
  - `[reservations] lock read-primary relazionale fallback: ...`
- I lock scaduti letti dal relazionale sono trattati come assenti, senza mutare app-state durante una lettura read-only.

## Guardrail

- Nessuna scrittura prenotazioni e' stata spostata su relazionale.
- `server.js` resta a 40499 righe.
- Rollback immediato: disattivare `BACKEND_RELATIONAL_RESERVATIONS_READS`.
- Il test E2E modifica il relazionale dopo il login, per evitare che la sync shadow post-login sovrascriva la fixture.

## Test eseguiti

- `node --check cassa-frontend/backend/modules/reservations/reservations.handlers.js`
- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs`
- `node --test cassa-frontend/backend/tests/relational-reservations-read-primary.test.mjs` -> 2/2 pass.
- `node --test cassa-frontend/backend/tests/reservations-domain.test.mjs cassa-frontend/backend/tests/reservations-status.e2e.test.mjs cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs` -> 17/17 pass.
- `node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 18/18 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53/53 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1/1 pass.

## Prossimo step

Procedere con J2: primo comando isolato su relazionale per il dominio prenotazioni/tavoli. Il candidato piu' sicuro e' `reservations/lock/acquire` o `tables/lock/acquire`, perche' e' un lease con scadenza e prepara il CAS senza toccare ancora lo stato economico.
