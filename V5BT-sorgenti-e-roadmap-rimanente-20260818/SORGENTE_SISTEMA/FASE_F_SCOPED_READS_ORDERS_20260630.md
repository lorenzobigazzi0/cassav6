# Fase F - Scoped Reads Orders

Data: 2026-06-30

## Obiettivo

Avviare lo scoped read di `GET /api/integration/orders` solo per il sotto-caso realmente read-only, senza toccare i percorsi postazione che riconciliano code e assegnazioni.

## Implementato

- Nuovo modulo `cassa-frontend/backend/modules/integration/scoped-orders-read.js`.
- Esteso `mysql-domains-split.repository.js` con `readObjectEntry(domain, fieldName, fallback)`.
- `GET /api/integration/orders` ora prova uno snapshot scoped quando:
  - `SCOPED_READS=1`;
  - MySQL domain split e' attivo;
  - la richiesta non ha `station`;
  - la richiesta non ha `includeDone=1`;
  - la richiesta non ha `currentSessionOnly=1`.
- Lo snapshot scoped legge solo:
  - `integration.orders`;
  - `integration.tableGroups`;
  - `integration.orderComps`;
  - `integration.orderCorrections`;
  - `integration.lastWriteAt`;
  - `posSettings`;
  - `menuItems`;
  - `users`.
- I path con side-effect restano sul vecchio `readDb()` completo:
  - postazione con `station`;
  - storico `includeDone=1`;
  - filtro sessione corrente `currentSessionOnly=1`.

## Guard rail

- Test `scoped-orders-read.test.mjs`:
  - verifica snapshot minimale;
  - verifica che `station`, `includeDone=1` e `currentSessionOnly=1` non attivino lo scoped path.
- Test repository aggiornato per coprire `readObjectEntry`.

## Verifiche

Comandi eseguiti:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/integration-current-table-session.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/app-state-repository.test.mjs`

Risultato:

- Scoped orders read: 2/2 pass.
- Integration current table session: 3/3 pass.
- Route policy architecture: 8/8 pass.
- Runtime metrics: 1/1 pass.
- App-state repository: 31/31 pass.
- `server.js`: 39998 righe.

## Prossimo step consigliato

Separare la riconciliazione operativa di `GET /api/integration/orders?station=...` in una lane/job dedicata, poi migrare anche quel path a letture scoped senza perdere:

- assegnazione ordini non assegnati;
- backfill operatori postazione;
- promozione coda preparazione.
