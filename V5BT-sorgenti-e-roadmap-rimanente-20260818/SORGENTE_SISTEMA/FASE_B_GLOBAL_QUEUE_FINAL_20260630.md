# Fase B - Ritiro Coda Globale

Data: 2026-06-30

## Obiettivo

Ridurre l'uso della coda globale DB come default, lasciandola attiva solo per mutazioni reali o route non ancora migrate.

## Implementato

Sono state rimosse dalla coda globale le POST di sola consultazione dei report:

- `POST /api/audit/events`
- `POST /api/reports/sales`
- `POST /api/reports/handheld-session`
- `POST /api/reports/non-fiscalized`

Queste route ora dichiarano:

- `mutation: false`
- `readOnly: true`
- `readOnlyReason`

## Route lasciate serializzate

Restano volutamente mutative e serializzate:

- `POST /api/audit/events/delete`
- `POST /api/reports/handheld-session/cash/open`
- `POST /api/reports/handheld-session/cash/close`
- `POST /api/reports/handheld-session/print`
- `POST /api/reports/payment-movement/reprint`

Motivo: cancellazioni audit, apertura/chiusura fondi cassa, stampa riepilogo palmari e ristampe movimenti scrivono audit, stato operativo o spool di stampa.

## Guard rail

Aggiunto un test architetturale dedicato in `cassa-frontend/backend/tests/route-policy-architecture.test.mjs`:

- blocca regressioni che rimettono i report read-only nella coda globale;
- conferma che le route report realmente mutative restino serializzate.

## Verifiche

Comandi eseguiti con Node locale:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/reports/reports.routes.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/security-architecture.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs`

Risultato:

- Syntax check OK.
- Route policy architecture: 8/8 pass.
- Security architecture: 4/4 pass.
- POS fiscal retry/report non fiscalizzati: 4/4 pass.
- `server.js` non modificato e resta a 39999 righe.

## Prossimo step consigliato

Procedere con Fase C / code di stampa o, se si vuole continuare il ritiro della globale, mappare le mutazioni residue per nuove lane dedicate:

- automatic cash lane;
- settings/admin lane;
- auth/session lane.
