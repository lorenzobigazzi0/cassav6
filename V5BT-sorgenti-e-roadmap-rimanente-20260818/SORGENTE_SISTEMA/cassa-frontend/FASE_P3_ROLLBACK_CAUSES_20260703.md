# Fase P3 - Rollback causes e retry ordini

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Il run precedente mostrava rollback e deadlock non spiegati sotto `load-50`.
Sono state aggiunte metriche a bassa cardinalita sullo split MySQL degli ordini
e un retry controllato per deadlock/lock wait sulle route del workflow ordine.

## Correzioni applicate

- Classificazione cause rollback in `appStateDomainSplit`:
  - `transientDbError`
  - `revisionConflict`
  - `duplicate`
  - `unknown`
- Nuove metriche per `integration.orders.entries`:
  - `error.<cause>`
  - `rollback.cause.<cause>`
  - `outcome.committed`
  - `outcome.rolledBack`
  - `rollback.failed`
- Retry transient MySQL anche per il workflow ordine, limitato alle route della
  order lane e prima della risposta HTTP 500.
- Guardrail statici per mantenere il retry limitato alle route corrette.

## Verifiche automatiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test \
  cassa-frontend/backend/tests/app-state-repository.test.mjs \
  cassa-frontend/backend/tests/runtime-metrics.test.mjs \
  cassa-frontend/backend/tests/route-policy-architecture.test.mjs \
  cassa-frontend/backend/tests/architecture-line-budget.test.mjs \
  cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs \
  cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs \
  cassa-frontend/backend/tests/notifications-persistence.e2e.test.mjs \
  cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs
```

Risultato: 95/95 pass.

## Evidenza load

Run pre-fix:

- `logs/loadtest-phaseP_load-50-p3-rollbackcauses/report.json`
- Durata 227s, business ops 1260, HTTP 3062, anomalie finali 91.
- Errori principali: 89 deadlock HTTP 500 su `orders/create`.

Run post-fix:

- `logs/loadtest-phaseP_load-50-p3-rollbackcauses-postfix/report.json`
- Durata 338s, business ops 1260, HTTP 3370, anomalie finali 0.
- Retry ordine osservati nel backend log: 147.
- RT fiscale mock: 3 tentativi, 3 successi HTTP.
- Code finali: `dbMutation=0`, `orderLane=0`.

Metriche post-fix principali:

| Metrica | Count | Avg | Max |
|---|---:|---:|---:|
| `appStateDomainSplit:integration.orders.entries.total` | 584 | 250.63 ms | 1429 ms |
| `appStateDomainSplit:integration.orders.entries.error.transientDbError` | 147 | 0 ms | 0 ms |
| `appStateDomainSplit:integration.orders.entries.commit` | 437 | 28.48 ms | 529 ms |
| `orderWorkflowStep:orders.create.mysql.orders` | 395 | 161.92 ms | 1429 ms |
| `orderWorkflowStep:orders.sync.mysql.orders` | 189 | 436.13 ms | 1162 ms |
| `orderWorkflow:orders.create.appStateWrite` | 248 | 689.05 ms | 2715 ms |
| `orderWorkflow:orders.sync.appStateWrite` | 189 | 927.20 ms | 2992 ms |

## Diagnosi aggiornata

Il retry evita che i deadlock transient diventino errori utente: nel profilo
post-fix le anomalie finali sono scese da 91 a 0.

Il prezzo e' l'aumento della durata del run e delle latenze ordine: il sistema
recupera le contese, ma sotto `load-50` la order lane resta il collo di bottiglia
principale. Il prossimo step deve ridurre la contesa che genera i 147 retry,
non solo recuperarla.

## Prossimo step

Continuare P3 riducendo la contesa su `orders/create`:

- isolare quale write MySQL genera i deadlock residui tra split domini, indice
  postazioni, audit e primary relazionale;
- ridurre le scritture ripetute di `station reconciliation` mentre la order lane
  e' in pressione;
- valutare batching/coalescing degli update puntuali ordine nella stessa
  mutazione.
