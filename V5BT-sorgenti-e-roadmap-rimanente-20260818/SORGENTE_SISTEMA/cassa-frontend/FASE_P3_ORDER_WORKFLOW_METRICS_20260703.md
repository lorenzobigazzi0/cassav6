# Fase P3 - Metriche workflow ordini

Data: 2026-07-03

## Obiettivo

Preparare il prossimo run `load-50` con metriche interne sufficienti a capire
dove si consuma il tempo della `order-lane`: coda, write-primary relazionale,
scrittura app-state split o lavoro asincrono di stampa.

## Interventi

- Aggiunta sezione runtime `operations.runMsByLabel`.
- Aggiunto dettaglio `appState.writeRunMsByLabel` per separare le scritture
  app-state per label esplicita o domini `splitDomains`.
- Etichettata la create ordine come `orders.create.appStateWrite`.
- Strumentati i write-primary relazionali:
  - `orderWorkflow:orders.create.relationalWrite`
  - `orderWorkflow:orders.sync.relationalWrite`
  - `orderWorkflow:orders.events.relationalAppend`
- `writeIntegrationOrderSyncDb` registra il tempo del fast path
  `orders.sync.appStateWrite` quando usa sync puntuale MySQL/SQLite.
- I report `loadtest-full-capacity.mjs` ed `endurance-sim-50k.mjs` mostrano
  ora le tabelle:
  - `Runtime Metrics - app-state write per label`
  - `Runtime Metrics - operations`

## Verifiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/app-state.repository.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/relational-order-create.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/relational-order-events.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/loadtest-full-capacity.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/endurance-sim-50k.mjs
```

Esito: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/app-state-repository.test.mjs cassa-frontend/backend/tests/phase-p-validation-preflight.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Esito: 62/62 test passati.

## Stato P3

P3 non e' ancora completata: questo step aggiunge osservabilita' mirata, non
marca verde `load-50`.

Prossimo step operativo:

- rilanciare un `load-50` controllato;
- leggere nel report le due nuove tabelle runtime;
- se il costo dominante e' `orders.create.appStateWrite`, ridurre o spostare
  fuori lane live audit/spool/cache non indispensabili;
- se il costo dominante e' `orders.*.relationalWrite`, lavorare sugli indici o
  sul path write-primary relazionale;
- se la coda cresce ma le operazioni restano rapide, tornare sulla policy di
  scheduling/concurrency della `order-lane`.
