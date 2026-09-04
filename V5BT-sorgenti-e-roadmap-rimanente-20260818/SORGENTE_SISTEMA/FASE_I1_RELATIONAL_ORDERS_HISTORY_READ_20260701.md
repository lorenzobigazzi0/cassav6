# Fase I1 - Relational orders history read

Data: 2026-07-01

## Obiettivo

Spostare sul relazionale la lettura read-only dello storico ordini per `GET /api/integration/orders?includeDone=1`, mantenendo invariati i flussi operativi e con fallback automatico all'app-state/split esistente.

## Implementazione

- Aggiunta sorgente opzionale relazionale in `cassa-frontend/backend/modules/integration/scoped-orders-read.js`.
- La sorgente si attiva solo per richieste read-only con `includeDone=1` e non si attiva per `currentSessionOnly=1`.
- Il server passa `relationalRuntime` allo scoped read e abilita la sorgente solo con:
  - `BACKEND_RELATIONAL_ORDERS_HISTORY_READS=1`
- In caso di errore del relazionale o DB non disponibile, lo scoped read torna alla sorgente precedente e scrive un warning:
  - `[scoped-reads] relational integration.orders fallback: ...`
- Il formato ordini resta quello originale grazie a `raw_json` idratato da `OrdersRelationalRepository`.

## Rollback

Disattivare `BACKEND_RELATIONAL_ORDERS_HISTORY_READS` o impostarlo a `0`.

La route continuera' a usare il percorso precedente basato su scoped app-state split/app-state.

## Test aggiunti

- `scoped orders read I1 usa relazionale per storico includeDone`
- `scoped orders read I1 usa il runtime relazionale reale`
- `scoped orders read I1 torna al fallback se il relazionale fallisce`

## Verifica eseguita

Comandi eseguiti con `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node`:

- `node --check cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/tests/scoped-orders-read.test.mjs`
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs` -> 9 pass
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs` -> 14 pass
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 11 pass
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs` -> 16 pass
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53 pass
- `node --test cassa-frontend/backend/tests/integration-current-table-session.test.mjs` -> 3 pass
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1 pass

## Esito

Fase I1 completata. Lo storico ordini read-only puo' ora essere letto dal relazionale con fallback automatico e rollback tramite flag.

Prossimo step roadmap: Fase I2, primo comando isolato/idempotente sugli eventi ordine, mantenendo app-state come verita' dello stato corrente.
