# Fase F - Payload postazione e cache station-scoped

Data: 2026-06-30

## Obiettivo

Dopo l'indice `integration.orders -> station`, ridurre il peso della GET postazione e usare la cache hot anche sulle richieste con `station`.

## Implementazione

- Postazione React:
  - la sincronizzazione ordini usa ora `station`, `clientApp=postazione`, `deviceUuid`, utente e `doneHistoryLimit=8`;
  - il build `postazione/dist` e' stato rigenerato.
- Postazione legacy:
  - aggiornato `postazione/js/core.js` con la stessa URL scoped.
- Bridge globale:
  - `postazione-single-station-orders-bridge.js` aggiunge `doneHistoryLimit=8` alle GET ordini station-scoped se manca.
- Backend:
  - la hot cache `integrationOrdersFastResponseCache` ora serve anche le richieste con `station`, usando la chiave query gia' normalizzata.
- Harness:
  - `station-orders-scoped-load.mjs` invia `doneHistoryLimit`, default `8`.

## File modificati

- `postazione/src/App.jsx`
- `postazione/js/core.js`
- `postazione/public/assets/postazione-single-station-orders-bridge.js`
- `postazione/dist/index.html`
- `postazione/dist/assets/index-CJ1bhRLl.js`
- `postazione/dist/assets/postazione-single-station-orders-bridge.js`
- `cassa-frontend/backend/server.js`
- `cassa-frontend/scripts/station-orders-scoped-load.mjs`

## Verifiche

- `npm run build` in `postazione` -> OK
- `node --check postazione/js/core.js` -> OK
- `node --check postazione/public/assets/postazione-single-station-orders-bridge.js` -> OK
- `node --check cassa-frontend/scripts/station-orders-scoped-load.mjs` -> OK
- `node --check cassa-frontend/backend/server.js` -> OK
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs` -> 5/5 pass

Nota test non eseguito:

- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs` non parte per dipendenza locale mancante: `Cannot find package 'jsdom'`.

## Misure payload

Prima, senza station scope:

- endpoint: `/api/integration/orders?includeDone=1&includeTransferred=1`
- ordini: 163
- byte: 1,188,061

Dopo, con station scope e storico limitato:

- endpoint: `/api/integration/orders?station=BAR-1&includeDone=1&includeTransferred=1&doneHistoryLimit=8`
- ordini: 8
- byte: 48,550

Riduzione payload: circa -95.9%.

## Mini-load

Prima della cache station-scoped, con payload limitato:

- run: `station-payload-limit-25`
- richieste: 500
- errori: 0
- p50: 2590.8 ms
- p95: 2992.4 ms
- p99: 3552.4 ms
- report: `logs/station-scoped-load-station-payload-limit-25-25/REPORT.md`

Dopo cache station-scoped:

- run: `station-cache-limit-25`
- richieste: 500
- errori: 0
- p50: 197.7 ms
- p95: 2727.3 ms
- p99: 3001.2 ms
- media: 586.2 ms
- report: `logs/station-scoped-load-station-cache-limit-25-25/REPORT.md`

## Note

- Il p50 e la media sono migliorati molto perche' i poll ripetuti della stessa postazione/device passano dalla cache.
- Il p95 resta alto per i primi miss concorrenti dei device: ogni device ha una chiave distinta quando invia `deviceUuid`, perche' il filtro operatore puo' dipendere anche dal device.
- Le metriche runtime interne del load restano non disponibili per login admin lento/non riuscito nello script (`loginOk=false`, `metricsAvailable=false`).
- Prossimo micro-step F consigliato: ridurre il costo del cache-miss station-scoped, spostando in query/repository anche i dati di correzioni/comp necessari alla postazione o introducendo una risposta lista + dettaglio ordine per-id.
