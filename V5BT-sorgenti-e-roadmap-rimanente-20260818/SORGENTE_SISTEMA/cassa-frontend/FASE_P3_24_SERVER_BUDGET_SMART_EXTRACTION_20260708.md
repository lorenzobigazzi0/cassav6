# FASE P3.24 - Server Budget e Smart Handlers

Data: 2026-07-08
Target: Raspberry `192.168.0.67`

## Obiettivo

Chiudere i tre rossi rimasti nel gate `route-policy-architecture` dopo P3.23:

- test statico financial sync `posSettings.tables`
- test statico layout GET in room lane
- margine M5 del monolite `backend/server.js`

## Modifica

Estratti gli handler Smart dal monolite:

- nuovo modulo `backend/modules/smart/smart.handlers.js`
- nuovo barrel `backend/modules/smart/index.js`
- wiring in `backend/server.js` tramite `createSmartHandlers`

Handler spostati:

- `handleSmartCustomers`
- `handleSmartCustomerUpsert`
- `handleSmartCustomerDelete`
- `handleSmartCardRead`
- `handleSmartCashBeachEntryConsume`
- `handleSmartCustomerRecharge`
- `handleSmartNonFiscal`

Aggiornato anche `backend/tests/route-policy-architecture.test.mjs` per riflettere il codice reale:

- `syncPosSettingsTablesFastPath` usa `syncState`, cioe la vista senza `workLock`
- il GET `/api/integration/layout` passa dall'helper `isIntegrationLayoutReadRequest`

## Budget

Prima:

- `backend/server.js`: 39.319 righe
- margine su budget 39.500: 181 righe
- gate M5 rosso

Dopo:

- `backend/server.js`: 38.757 righe
- margine su budget 39.500: 743 righe
- gate M5 verde

## Verifiche locali

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/smart/smart.handlers.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/route-policy-architecture.test.mjs
```

Esito locale:

- `route-policy-architecture`: 87/87 passati

## Deploy target

File copiati su target:

- `backend/server.js`
- `backend/modules/smart/index.js`
- `backend/modules/smart/smart.handlers.js`
- `backend/tests/route-policy-architecture.test.mjs`

Verifiche target:

- `node --check` su `server.js` e modulo Smart: OK
- `route-policy-architecture`: 87/87 passati
- servizi riavviati: `cassav4-backend`, `cassav4-api-worker@5283`, `cassav4-api-worker@5284`
- health `https://127.0.0.1:5280/api/health`: OK
- log owner: stampa disabilitata
- log fiscale: I/O reale disabilitato per test

Smoke runtime:

- login `amalia / 182018`: HTTP 200
- `POST /api/smart/customers`: HTTP 200, `ok:true`

## Esito

Step completato:

- gate architetturale tornato verde
- margine M5 ripristinato sopra 700 righe
- modulo Smart funzionante a runtime sul target

Prossimo step consigliato: riprendere la roadmap sulle latenze residue C3, ora che il gate statico e il budget monolite sono di nuovo stabili.
