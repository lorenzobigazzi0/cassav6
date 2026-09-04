# Fase F - Indice ordini per postazione

Data: 2026-06-30

## Obiettivo

Ridurre il costo della GET postazione `/api/integration/orders?station=...` evitando il filtro testuale su JSON per individuare gli ordini della postazione.

## Implementazione

- Aggiunta tabella MySQL `app_state_domain_records_order_station_index`.
- Aggiunto indice logico `integration.orders -> station` con `match_kind`:
  - `primary`: `assignedStationId`, `ownerStation`, `lockedByStationId`;
  - `fallback`: `station` oppure route/ticket/lineRoutes solo per ordini legacy senza assegnazione primaria;
  - `transferred`: `transferredFromStation`, `transferredToStation`.
- Backfill automatico all'avvio se la tabella indice e' vuota.
- Aggiornamento indice nella stessa transazione delle scritture `integration.orders`:
  - full sync: ricostruzione completa;
  - sync singola comanda: cancellazione/reinserimento solo dei record cambiati.
- `readScopedIntegrationOrdersDb` usa prima `readIntegrationOrdersForStation`; se l'indice non e' disponibile torna al fallback testuale.

## File modificati

- `cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js`
- `cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `cassa-frontend/backend/tests/app-state-repository.test.mjs`
- `cassa-frontend/backend/tests/scoped-orders-read.test.mjs`

## Verifiche

- `node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js`
- `node --check cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs cassa-frontend/backend/tests/app-state-repository.test.mjs` -> 34/34 pass
- `node --test cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs cassa-frontend/backend/tests/scoped-orders-read.test.mjs` -> 8/8 pass
- `node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/order-route-policy.test.mjs` -> pass per runtime metrics

## Verifica live

- Riavvio: `./tools/restart-cassav4-linux.sh`
- Backend OK: `http://127.0.0.1:5281/api/health`
- Frontend HTTPS OK: `https://192.168.0.74:5280/mobile/`
- Tabella indice creata e popolata:
  - righe indice: 165
  - ordini distinti indicizzati: 163
  - `BAR-1 primary`: 163

## Mini-load

Comando:

```bash
STATION_LOAD_RUN_ID=station-index-25 \
STATION_LOAD_DEVICES=25 \
STATION_LOAD_REQUESTS_PER_DEVICE=20 \
STATION_LOAD_STATIONS='BAR-1' \
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node cassa-frontend/scripts/station-orders-scoped-load.mjs
```

Risultato:

- richieste: 500
- errori: 0
- status HTTP 200: 500
- p50: 2583.5 ms
- p95: 3026.3 ms
- p99: 3547.5 ms
- max: 3604.2 ms
- report: `logs/station-scoped-load-station-index-25-25/REPORT.md`

## Note

- Nel dataset live tutti i 163 ordini risultano assegnati a `BAR-1`, quindi l'indice riduce il costo della selezione DB ma non riduce ancora la dimensione del payload della postazione.
- Le metriche runtime interne non sono state raccolte dal mini-load perche' il login admin dello script e' rimasto non disponibile/lento (`loginOk=false`, `metricsAvailable=false`), come nel run precedente.
- Prossimo passo consigliato in Fase F: ridurre il payload postazione dopo il lookup indicizzato, separando lista sintetica e dettaglio ordine oppure escludendo lo storico non necessario dalla lettura calda.
