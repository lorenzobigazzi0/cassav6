# Fase I4 - Orders Cancel Write-Primary Relazionale - 2026-07-01

## Obiettivo

Proseguire I4 della `ROADMAP_REALTIME_CASSAV4_v3.md` completando il sotto-step `POST /api/integration/orders/cancel` come write-primary relazionale con CAS su `orders.revision`.

## Interventi

- Aggiunto flag `BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1`.
- Il flag aggregato `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1` e l'alias roadmap `ORDERS_RELATIONAL_WRITE_PRIMARY=1` abilitano anche `cancel`.
- La rotta `orders/cancel` ora scrive il relazionale con CAS prima del mirror app-state, della coda stampa e del publish realtime.
- Il CAS usa la revision corrente dell'ordine e fallisce con `409 REVISION_CONFLICT` se la riga relazionale e' stata aggiornata da un'altra scrittura.
- Il comportamento applicativo esistente resta invariato:
  - ordine annullato;
  - `total`, `paidAmount`, `dueAmount` azzerati;
  - item marcati `voidedAt`;
  - ticket di annullamento simulabile/accodabile;
  - sync successiva verso ready bloccata con `ORDER_CANCELLED`.
- Adeguato il test security `order correction after station checkbox...`: dopo `orders/sync` usa la revision restituita dalla risposta invece di una revision stale hardcoded a `1`.
- `server.js` resta sotto budget architetturale: 40.499 righe.

## Test aggiunti

- `relational-orders-cancel-write-primary.e2e.test.mjs`
  - create primary + cancel primary;
  - verifica `orders.status = cancelled`;
  - verifica `orders.revision = 2`;
  - verifica raw JSON con `currentRevision = 2`;
  - simula conflitto CAS alterando la revision relazionale dopo il lock tavolo;
  - verifica risposta `409 REVISION_CONFLICT` e mirror app-state non avanzato.

## Verifica eseguita

- `node --check` su server e nuovo test: OK.
- `node --test cassa-frontend/backend/tests/relational-orders-cancel-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs`: 20 pass.
- `node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs`: 5 pass.
- `node --test cassa-frontend/backend/tests/security.test.mjs`: 29 pass.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 16 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`: 9 pass.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 6 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.

## Stato

I4 ha completato `create`, `sync` e `cancel` dietro flag. Restano `correct` e `comp`, da fare per ultimi perche' toccano righe ordine, importi, storni, pagabilita' e interazioni con pagamenti/fiscale.
