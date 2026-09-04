# Fase F - Scoped Reads Stazioni

Data: 2026-06-30

## Obiettivo

Avviare la Fase F della roadmap Near-Real-Time: ridurre le letture `readDb()` dello stato completo sui path caldi, partendo da un endpoint frequente e a basso rischio.

## Implementato

- Aggiunto flag `SCOPED_READS=1`.
- Esteso `mysql-domains-split.repository.js` con:
  - `readDomainValue(domain, fallback)`
  - `readObjectArrayField(domain, fieldName, fallback)`
- `GET /api/integration/stations/state` ora, con `SCOPED_READS=1` e MySQL domain split attivo, legge solo:
  - `integration.stationStates`
  - `posSettings`
- La risposta mantiene:
  - `configuredStations`
  - `stations`
  - `version`
  - `showDemoStations`
- Se lo snapshot scoped rileva zero postazioni attive, torna al path completo per preservare l'alert operativo `station_availability_alert`.
- `GET /api/integration/stations/active` resta sul path completo in questa prima passata perche' puo' generare side-effect di alert e va migrato separatamente.
- Abilitato `SCOPED_READS=1` in:
  - `tools/restart-cassav4-linux.sh`
  - `cassa-frontend/scripts/loadtest-full-capacity.mjs`
  - `cassa-frontend/scripts/endurance-sim-50k.mjs`

## Guard rail

Aggiunto test repository:

- `app-state MySQL domain split legge campi scoped senza idratare tutto il dominio`

Il test verifica che `integration.stationStates` e `posSettings` vengano letti dal domain split senza caricare `integration.orders`.

## Verifiche

Comandi eseguiti:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/loadtest-full-capacity.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/endurance-sim-50k.mjs`
- `bash -n tools/restart-cassav4-linux.sh`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/app-state-repository.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Risultato:

- App-state repository: 31/31 pass.
- Route policy architecture: 8/8 pass.
- Runtime metrics: 1/1 pass.
- `server.js`: 39995 righe.

## Verifica live

Sistema riavviato con backend/frontend HTTPS.

- Backend: `http://127.0.0.1:5281/api/health` OK, DB MySQL.
- Frontend: `https://127.0.0.1:5280/mobile/` OK.
- LAN: `https://192.168.0.74:5280/mobile/`.
- Env backend confermato: `SCOPED_READS=1`.
- `GET /api/integration/stations/state`: `ok=true`, `stationCount=6`, `configuredCount=6`.

## Prossimo step consigliato

Continuare Fase F su una lettura calda che oggi richiede ancora molto stato:

- `GET /api/integration/orders` con lettura scoped di `integration.orders`, `menuItems` e pochi campi settings;
- oppure `GET /api/integration/layout` separando `posSettings.tables` e statistiche ordini attive.
