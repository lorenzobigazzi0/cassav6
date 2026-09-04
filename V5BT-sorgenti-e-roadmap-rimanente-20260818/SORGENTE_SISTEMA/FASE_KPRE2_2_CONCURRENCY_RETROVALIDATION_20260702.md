# Fase K-PRE.2.2 - Validazione retroattiva concorrenza reale

Data: 2026-07-02

## Scope

Applicazione dell'harness K-PRE.2.1 a due casi gia' implementati in Fase J,
con richieste HTTP realmente parallele sullo stesso target:

- `POST /api/tables/lock/acquire` (J8)
- `POST /api/pos/reservations/lock/acquire` (J2)

## File creati

- `cassa-frontend/backend/tests/concurrency-cas-regression.e2e.test.mjs`

## Dettaglio tecnico

Il test usa `fireConcurrent(...)` con due sessioni e due device diversi:

- lock tavolo: `cashier` contro `manager`, stesso `tableId`;
- lock prenotazione: `admin_test` contro `manager`, stesso `reservationId`.

Per entrambi i casi l'atteso e':

- una sola risposta HTTP 2xx;
- una risposta HTTP 409;
- persistenza di un solo lock nel DB relazionale;
- mirror app-state coerente con il lock relazionale.

## Esito casi K-PRE.2.2

- `tables.lock.acquire`: PASS. Una richiesta ottiene il lock, l'altra riceve
  `409` con `code = TABLE_LOCKED`.
- `pos.reservations.lock.acquire`: PASS. Una richiesta ottiene il lock, l'altra
  riceve `409` con errore coerente su lock di altro operatore.

Nessun finding bloccante sul CAS reale osservato in questi due casi.

## Verifiche eseguite

- `node --check backend/tests/concurrency-cas-regression.e2e.test.mjs`
- `node --test backend/tests/concurrency-cas-regression.e2e.test.mjs`: 2/2 OK.
- `node --test backend/tests/concurrency-harness.test.mjs`: 3/3 OK.
- `node --test backend/tests/relational-table-locks-write-primary.test.mjs`: 4/4 OK.
- `node --test backend/tests/relational-reservations-lock-write-primary.test.mjs`: 18/18 OK.
- `node --test backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Decisione

PASS. K-PRE.2.2 completata.

## STOP / REVIEW

Come richiesto dalla roadmap, fermarsi qui prima di procedere con K-PRE.2.3
(documentare il pattern per riuso in K4-K7).
