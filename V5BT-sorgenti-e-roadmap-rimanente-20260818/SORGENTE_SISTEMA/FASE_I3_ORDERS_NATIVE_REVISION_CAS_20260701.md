# Fase I3 - Orders Native Revision CAS - 2026-07-01

## Obiettivo

Completare il passo I3 della `ROADMAP_REALTIME_CASSAV4_v3.md`: aggiungere una `revision` nativa al dominio ordini relazionale e preparare le scritture puntuali con controllo ottimistico `WHERE id = ? AND revision = ?`.

## Interventi

- Aggiunta migrazione `011_orders_revision.sql` con `orders.revision INTEGER NOT NULL DEFAULT 1`.
- Registrata la migrazione `011` in `db/relational/migrations.js`.
- Esteso `mapOrderToRelationalRow` per importare `revision`/`currentRevision` dallo stato applicativo, con default sicuro a `1`.
- Esteso l'insert relazionale degli ordini per persistere `revision`.
- Estesa l'idratazione degli ordini per esporre `revision` e `currentRevision`.
- Aggiunto `OrdersRelationalRepository.updateOrderWithRevision(id, expectedRevision, patch)`:
  - incrementa `revision = revision + 1`;
  - applica `status`, `updatedAt` e `rawJson` quando presenti;
  - ritorna l'ordine aggiornato solo se il CAS riesce;
  - ritorna `null` su revision stale/mismatch.
- Aggiornata l'equivalenza shadow degli ordini per includere `revision`.
- Aggiornati i test di migrazione da 10 a 11 versioni attese.

## Test aggiunti

- `relational-orders.test.mjs`
  - verifica presenza colonna `orders.revision`;
  - verifica preservazione `revision` durante sync shadow;
  - verifica CAS con incremento revision e rifiuto di update stale.

## Verifica eseguita

- `node --check` sui file backend/test toccati: OK.
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs`: 17 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53 pass.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 6 pass.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 16 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`: 9 pass.

## Stato

Fase I3 completata. Il prossimo passo di roadmap e' I4: write-primary relazionale per `create`, poi `sync`, poi `correct/cancel/comp`, con sotto-flag e STOP/REVIEW dopo ogni sotto-step.
