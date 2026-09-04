# Fase K-PRE.2.1 - Concurrency harness

Data: 2026-07-02

## Scope

Costruzione di un harness riusabile per lanciare richieste HTTP realmente
simultanee, con barriera esplicita prima del `fetch`, da riutilizzare nelle
validazioni CAS e nei futuri step K4-K7.

## File creati

- `cassa-frontend/backend/tests/helpers/concurrency-harness.mjs`
- `cassa-frontend/backend/tests/concurrency-harness.test.mjs`

## Dettaglio tecnico

Il nuovo helper esporta:

- `fireConcurrent(requests, options)`: prepara tutte le richieste, attende una
  barriera condivisa e solo dopo rilascia i `fetch` in parallelo. Ritorna
  `Promise.allSettled(...)` con metadati di stato, durata e `Response`.
- `assertExactlyOneSucceeded(results)`: verifica che una sola richiesta abbia
  risposta HTTP 2xx.
- `assertAllIdempotentReplay(results, expectedBody)`: verifica che tutte le
  richieste siano HTTP 2xx e producano lo stesso body JSON atteso.

Il test meta usa un server HTTP locale con endpoint serializzato a monte:
l'harness verifica che nessuna richiesta arrivi prima del rilascio della
barriera, poi entrambe completano con HTTP 200 mentre il server resta seriale
(`maxActiveCount = 1`). Questo separa la validazione dello strumento dal
comportamento del dominio applicativo, che sara' coperto in K-PRE.2.2.

## Verifiche eseguite

- `node --check backend/tests/helpers/concurrency-harness.mjs`
- `node --check backend/tests/concurrency-harness.test.mjs`
- `node --test backend/tests/concurrency-harness.test.mjs`: 3/3 OK.
- `node --test backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Esito

PASS. K-PRE.2.1 completata.

## STOP / REVIEW

Come richiesto dalla roadmap, fermarsi qui prima di procedere con K-PRE.2.2
(validazione retroattiva su `tables.lock.acquire` e
`pos.reservations.lock.acquire`).
