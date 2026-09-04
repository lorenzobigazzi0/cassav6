# FASE K2 - Payments revision nativa e CAS

Data: 2026-07-02

## Obiettivo

Chiudere K2 della `ROADMAP_REALTIME_CASSAV4_v4.md`: aggiungere `revision` nativa su `payment_containers` e `payment_transactions`, preparare i metodi CAS relazionali e aggiornare l'equivalenza shadow prima di qualunque write-primary sui pagamenti.

## Interventi

- Aggiunta migrazione `015_payments_revision.sql`:
  - `payment_containers.revision INTEGER NOT NULL DEFAULT 1`;
  - `payment_transactions.revision INTEGER NOT NULL DEFAULT 1`.
- Registrata la migrazione `015 payments_revision` nel runner relazionale.
- Aggiornati mapper e insert payments:
  - `payment_containers` conserva `revision/currentRevision` da app-state quando presente;
  - `payment_transactions` conserva `revision/currentRevision` sia per transazioni applicative sia per provider transactions;
  - hydrate di container e transaction espone sempre `revision` e `currentRevision`.
- Aggiunti metodi CAS:
  - `PaymentsRelationalRepository.updateContainerWithRevision(id, expectedRevision, patch)`;
  - `PaymentsRelationalRepository.updateTransactionWithRevision(id, expectedRevision, patch)`.
- Aggiornata l'equivalenza shadow payments per includere `revision` su container e transaction.
- Aggiornati i test che verificano il numero/lista delle migrazioni da 14 a 15.

## File modificati

- `cassa-frontend/backend/db/relational/migrations/015_payments_revision.sql`
- `cassa-frontend/backend/db/relational/migrations.js`
- `cassa-frontend/backend/db/relational/payments.repo.js`
- `cassa-frontend/backend/db/relational/equivalence.js`
- `cassa-frontend/backend/tests/relational-payments.test.mjs`
- `cassa-frontend/backend/tests/relational-shadow.test.mjs`
- `cassa-frontend/backend/tests/relational-migration-script.test.mjs`

## Verifiche eseguite

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/payments.repo.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/equivalence.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/migrations.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/relational-payments.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-equivalence.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-shadow.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-migration-script.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-reports-read-primary.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/fiscal-optimism-boundary.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esiti:

- `relational-payments.test.mjs`: 19/19 verdi.
- `relational-equivalence.test.mjs`: 12/12 verdi.
- `relational-shadow.test.mjs`: 53/53 verdi.
- `relational-migration-script.test.mjs`: 6/6 verdi.
- `relational-payments-reports-read-primary.test.mjs`: 4/4 verdi.
- `payments-fiscal.e2e.test.mjs`: 16/16 verdi.
- `fiscal-optimism-boundary.e2e.test.mjs`: 5/5 verdi.
- `architecture-line-budget.test.mjs`: 1/1 verde.
- `backend/server.js`: 37.953 righe, sotto budget.

## DoD K2

- Colonne `revision` presenti su `payment_containers` e `payment_transactions`.
- Sync shadow payments conserva `revision/currentRevision` quando presenti nell'app-state.
- CAS container incrementa revision e rifiuta update stale.
- CAS transaction incrementa revision e rifiuta update stale.
- Equivalenza shadow payments include `revision`.
- Nessun flag strutturale introdotto e nessun cambio comportamentale sui flussi di incasso.

## Esito

K2 completata.

STOP/REVIEW K2 rispettato. Il prossimo step della roadmap e' K3: `fiscal/command` come retry tecnico write-primary relazionale a basso rischio.
