# Fase I4 - Orders Sync Write-Primary Relazionale - 2026-07-01

## Obiettivo

Proseguire I4 della `ROADMAP_REALTIME_CASSAV4_v3.md`: dopo `orders/create`, attivare anche `POST /api/integration/orders/sync` come write-primary relazionale con CAS su `orders.revision`.

## Interventi

- Aggiunto flag `BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1`.
- Il flag aggregato `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1` e l'alias roadmap `ORDERS_RELATIONAL_WRITE_PRIMARY=1` abilitano anche `sync`.
- Esteso `OrdersRelationalRepository` con `replaceOrderWithRevision(order, expectedRevision)`:
  - aggiorna la riga `orders` con `revision = revision + 1`;
  - sostituisce righe, varianti ed eventi dell'ordine;
  - usa `WHERE id = ? AND revision = ?`;
  - ritorna `null` su mismatch CAS.
- Esteso il modulo `relational-order-create.js` con `syncRelationalOrderPrimary(...)`.
- La rotta `orders/sync` ora:
  - incrementa `revision/currentRevision` della comanda sincronizzata;
  - scrive il relazionale con CAS prima del publish realtime e prima del mirror app-state;
  - ritorna `409 REVISION_CONFLICT` se il relazionale ha una revision diversa.
- `server.js` resta sotto budget architetturale: 40.498 righe.

## Test aggiunti

- `relational-orders.test.mjs`
  - `replaceOrderWithRevision sostituisce grafo ordine con CAS`.
- `relational-orders-sync-write-primary.e2e.test.mjs`
  - create primary + sync primary;
  - verifica `orders.revision = 2`, raw JSON e righe ordine;
  - simula conflitto CAS alterando la revision relazionale;
  - verifica risposta `409 REVISION_CONFLICT` e mirror app-state non avanzato.

## Verifica eseguita

- `node --check` su repository, modulo, server e nuovi test: OK.
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs`: 20 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs`: 5 pass.
- `node --test cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53 pass.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 16 pass.
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`: 9 pass.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 6 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.

## Stato

I4 ha ora completato i sotto-step `create` e `sync` dietro flag. Restano `correct/cancel/comp`, da fare per ultimi perche' toccano importi, pagabilita', storni e pagamenti.
