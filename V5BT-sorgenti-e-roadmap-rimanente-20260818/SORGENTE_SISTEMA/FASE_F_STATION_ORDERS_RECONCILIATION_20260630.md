# Fase F - Station Orders Reconciliation

Data: 2026-06-30

## Obiettivo

Preparare `GET /api/integration/orders?station=...` alla migrazione verso letture scoped, separando la riconciliazione operativa dal corpo dell'handler.

## Implementato

- Nuovo modulo `cassa-frontend/backend/modules/integration/station-orders-reconciliation.js`.
- La riconciliazione della GET postazione ora passa da `applyStationOrdersPollReconciliation`.
- Il modulo incapsula:
  - assegnazione ordini in coda senza postazione;
  - backfill operatore postazione;
  - promozione coda preparazione;
  - prune dello stato integration.
- `handleIntegrationOrders` resta compatibile con il comportamento precedente, ma non contiene piu' la sequenza manuale di riconciliazione.

## Guard rail

- Test unitario nuovo: `station-orders-reconciliation.test.mjs`.
- Test postazione mantenuto: `postazione-preparation-selection.e2e.test.mjs`.
- Test filtro/sessione ordini mantenuto: `integration-current-table-session.test.mjs`.
- Gate architetturale mantenuto sotto limite hard: `server.js` a 39997 righe.

## Verifiche

Comandi eseguiti:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/station-orders-reconciliation.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs cassa-frontend/backend/tests/scoped-orders-read.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/integration-current-table-session.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Risultato:

- Station orders reconciliation: 2/2 pass.
- Scoped orders read: 2/2 pass.
- Postazione preparation selection: 1/1 pass.
- Integration current table session: 3/3 pass.
- Route policy + runtime metrics: 9/9 pass.

## Prossimo step consigliato

Spostare la riconciliazione postazione appena estratta in una lane dedicata o in un job post-response, poi abilitare lo scoped read anche per la GET postazione quando non serve attendere la riconciliazione.
