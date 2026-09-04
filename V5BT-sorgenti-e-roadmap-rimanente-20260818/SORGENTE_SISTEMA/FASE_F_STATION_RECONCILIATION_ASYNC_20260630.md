# Fase F - Station Reconciliation Async

Data: 2026-06-30

## Obiettivo

Togliere dalla GET postazione la scrittura immediata di riconciliazione, preparando `GET /api/integration/orders?station=...` allo scoped read.

## Implementato

- `station-orders-reconciliation.js` ora espone `createStationOrdersPollReconciliationScheduler`.
- La scheduler:
  - deduplica i poll ravvicinati per postazione;
  - legge lo stato con `readDb({ preferCache: true })`;
  - applica la riconciliazione gia' estratta;
  - persiste solo se ci sono cambi reali;
  - usa la lane ordini tramite `withOrderSyncLaneMutation`.
- `handleIntegrationOrders` non applica piu' direttamente assegnazione/backfill/promozione nella GET postazione.
- Le richieste con `station` non usano il fast-cache early-return prima di schedulare la riconciliazione.
- Il prune dello stato integration non viene piu' eseguito inline per la GET postazione: passa dal job.

## Guard rail

- Test scheduler:
  - persistenza asincrona quando cambia qualcosa;
  - deduplica della stessa postazione mentre un job e' pendente.
- Flusso postazione esistente mantenuto.
- Gate architetturale ancora sotto limite hard: `server.js` a 39988 righe.

## Verifiche

Comandi eseguiti:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/station-orders-reconciliation.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/integration-current-table-session.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`

Risultato:

- Station orders reconciliation/scheduler: 4/4 pass.
- Scoped orders read: 2/2 pass.
- Runtime metrics: 1/1 pass.
- Postazione preparation selection: 1/1 pass.
- Integration current table session: 3/3 pass.
- Route policy architecture: 8/8 pass.

## Prossimo step consigliato

Abilitare uno scoped snapshot anche per la GET postazione, leggendo solo ordini, gruppi tavolo, compensazioni, correzioni, settings/menu/users, mentre la riconciliazione resta asincrona sulla lane ordini.
