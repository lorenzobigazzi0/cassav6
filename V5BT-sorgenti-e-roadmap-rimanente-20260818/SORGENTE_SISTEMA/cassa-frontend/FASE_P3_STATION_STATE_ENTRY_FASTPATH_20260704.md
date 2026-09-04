# Fase P3 - Station state entry fast path

Data: 2026-07-04

## Contesto

Il canary `phaseP_interinale_p3_secondary_order_writes_canary8_50` aveva chiuso senza errori utente, ma nei log backend restavano retry transient MySQL sul percorso station-state:

- `Retry station state dopo errore MySQL transient (1/3): Deadlock found when trying to get lock`
- label generico ancora presente: `route:POST /api/integration/stations/state.appStateWrite`

Questo indicava che gli heartbeat/stati postazione potevano ancora cadere nel fallback full-domain invece di aggiornare solo la singola voce `integration.stationStates`.

## Intervento

- Aggiunto `integrationStationStateMysqlRecordId(entry, position)` in `backend/server.js`.
- Esteso `writeIntegrationStationStatesDb(db, options)` per sincronizzare una singola entry `integration.stationStates` quando viene passato `stationStateIds`.
- Il fast path di `POST /api/integration/stations/state` ora passa l'ID puntuale della postazione aggiornata.
- Il percorso lento e realmente mutativo ora usa label esplicita `stationState.upsert.appStateWrite` con domini scoped `integration`, `sessions`, `auditEvents`.
- Aggiunto test architetturale per impedire regressioni verso il fallback route-level.

## Verifiche

Comandi eseguiti:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs --test-name-pattern 'heartbeat|stato postazione|postazione attiva'
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/app-state-repository.test.mjs --test-name-pattern 'MySQL domain split|deviceStatus upsert|deviceStatus externalized'
```

Esito:

- `server.js --check`: OK
- `route-policy-architecture`: 46/46 OK
- `station-pause-transfer.e2e`: 13/13 OK
- `app-state-repository`: 40/40 OK
- budget M5 `server.js`: 38.793 righe, margine 707 righe

## Smoke

Run: `phaseP_interinale_p3_station_state_entry_smoke_12`

- 12 palmari, 6 postazioni, 5 operazioni per device
- durata 32s
- business ops 90
- HTTP request 361
- failure 0
- RT fiscale reale 0
- coda finale `dbMutation/orderLane`: `0 / 0`
- `stationState.upsert.appStateWrite`: count 2, avg 390.5ms, p95 bucket `<=500`, max 446ms
- `POST /api/integration/stations/state` writeDb p95 bucket `<=0`, max 1
- nessun retry/deadlock station-state nel backend log

Report:

- `logs/loadtest-phaseP_interinale_p3_station_state_entry_smoke_12/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_station_state_entry_smoke_12/report.json`

## Canary concorrenza 8

Run: `phaseP_interinale_p3_station_state_entry_canary8_50`

- 50 palmari, 12 postazioni, 12 operazioni per device
- durata 104s
- business ops 744
- HTTP request 1994
- failure 0
- RT fiscale reale 0
- DB written approx 72.26 MB
- coda finale `dbMutation/orderLane`: `0 / 0`
- `POST /api/integration/stations/state`: 246 richieste, writeDb avg 0, p95 bucket `<=0`, max 0
- `stationState.upsert.appStateWrite`: count 15, avg 560.13ms, p95 bucket `<=1000`, max 1000ms
- nessun `Retry station state`
- nessun `Deadlock found` su station-state
- nessun `route:POST /api/integration/stations/state.appStateWrite`

Report:

- `logs/loadtest-phaseP_interinale_p3_station_state_entry_canary8_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_station_state_entry_canary8_50/report.json`

## Stato gate

Questo step chiude il filo scoperto sui retry station-state e rende osservabile il percorso lento con label dedicata.

Il gate P3 non e' ancora verde: nel canary da 50 device le latenze ordine restano alte, ad esempio:

- `order.create` p95 11016ms
- `order.sync.delivered` p95 11002ms
- `order.sync.ready` p95 11681ms
- `order.correct` p95 10828ms

Questi valori indicano che il prossimo intervento deve attaccare la coda lunga degli ordini, non piu' i fallback station-state.

## Prossimo passo consigliato

Procedere con la parte della roadmap interinale P3 sugli outlier:

1. estrarre dal report/events quali `orders/create`, `orders/sync`, `orders/correct`, `order.comp` finiscono sopra 2s;
2. correlare con numero righe, eventi audit, correzioni pregresse e tipo operazione;
3. se la correlazione e' netta, separare le operazioni pesanti in priorita/lane dedicata per evitare head-of-line blocking.
