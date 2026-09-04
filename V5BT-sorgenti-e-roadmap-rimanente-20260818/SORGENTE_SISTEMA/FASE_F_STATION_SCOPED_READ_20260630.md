# Fase F - Station Scoped Read

Data: 2026-06-30

## Obiettivo

Abilitare lo scoped snapshot anche per `GET /api/integration/orders?station=...`, ora che la riconciliazione postazione e' asincrona sulla lane ordini.

## Implementato

- `readScopedIntegrationOrdersDb` non spegne piu' lo scoped read per:
  - `station=...`;
  - `includeDone=1`.
- Lo scoped read resta spento per `currentSessionOnly=1`, perche' quel filtro richiede ancora lo stato completo delle sessioni/tavoli.
- La GET postazione continua a schedulare la riconciliazione asincrona tramite `scheduleStationOrdersPollReconciliation`.
- La cache veloce continua a non fare early-return sulle richieste con `station`, cosi' ogni poll puo' schedulare la riconciliazione deduplicata.

## Guard rail

- Test `scoped-orders-read.test.mjs` aggiornato:
  - `station=BAR&includeDone=1&includeTransferred=1` deve usare snapshot scoped;
  - `currentSessionOnly=1` deve restare su path completo.
- Test scheduler postazione mantenuti.
- Test e2e postazione mantenuto.

## Verifiche

Comandi eseguiti:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/app-state-repository.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/integration-current-table-session.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Risultato:

- Scoped orders + station scheduler: 7/7 pass.
- App-state repository: 31/31 pass.
- Postazione preparation selection: 1/1 pass.
- Integration current table session: 3/3 pass.
- Route policy + runtime metrics: 9/9 pass.
- `server.js`: 39988 righe.

## Prossimo step consigliato

Eseguire un mini-load 25/50 con focus su `orders?station=...`, confrontando:

- readDb per richiesta;
- p95 della GET postazione;
- profondita' lane ordini durante poll multipli;
- assenza di regressioni sulla promozione automatica della coda preparazione.
