# Fase I4 - Orders Comp Write-Primary Relazionale - 2026-07-01

## Obiettivo

Completare la Fase I4 della `ROADMAP_REALTIME_CASSAV4_v3.md` portando `POST /api/integration/orders/comp` a scrittura primaria relazionale con CAS su `orders.revision`.

## Interventi

- Aggiunto flag `BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1`.
- Il flag aggregato `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1` e l'alias roadmap `ORDERS_RELATIONAL_WRITE_PRIMARY=1` abilitano anche `comp`.
- La rotta `orders/comp` ora aggiorna il record ordine relazionale con CAS prima di salvare il mirror app-state.
- In caso di mismatch revision relazionale viene restituito `409 REVISION_CONFLICT` e il mirror JSON non viene avanzato.
- La semantica applicativa del comp resta invariata:
  - storno su ordine non pagato;
  - storno/rimborso su ordine pagato;
  - piani refund cash/POS/roman/article;
  - sostituzione a costo zero;
  - record `orderComps`, print job e audit.
- Adeguata `continuity.e2e.test.mjs` alle revision native: dopo `orders/sync` usa la revision restituita invece di `1` hardcoded.
- `table-groups/save` ora risincronizza i financials prima del write, cosi' il DB letto subito dopo un merge/split contiene i totali tavolo aggiornati come il layout live.
- `server.js` resta sotto budget architetturale: 40.499 righe.

## Test aggiunti

- `relational-orders-comp-write-primary.e2e.test.mjs`
  - create + ready sync + comp primary;
  - verifica `orders.revision = 3`;
  - verifica `orders.total_cents = 0`;
  - verifica raw JSON con `currentRevision = 3`;
  - simula conflitto CAS alterando la revision relazionale dopo il lock tavolo;
  - verifica risposta `409 REVISION_CONFLICT`, mirror app-state non avanzato e nessun `orderComps` stale.

## Verifica eseguita

- `node --check cassa-frontend/backend/server.js`: OK.
- `node --check cassa-frontend/backend/tests/relational-orders-comp-write-primary.e2e.test.mjs`: OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-comp-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-cancel-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs`: 2 pass.
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs`: 20 pass.
- `node --test cassa-frontend/backend/tests/security.test.mjs`: 29 pass.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 16 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs cassa-frontend/backend/tests/scoped-orders-read.test.mjs cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 20 pass.
- `node --test cassa-frontend/backend/tests/continuity.e2e.test.mjs`: 69 pass.

## Stato

I4 ha completato `create`, `sync`, `cancel`, `correct` e `comp` dietro flag. La Fase I e' pronta per review/stop previsto dalla roadmap prima di passare alla Fase J.
