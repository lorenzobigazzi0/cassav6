# Fase I4 - Orders Correct Write-Primary Relazionale - 2026-07-01

## Obiettivo

Proseguire la Fase I della `ROADMAP_REALTIME_CASSAV4_v3.md` portando `POST /api/integration/orders/correct` a scrittura primaria relazionale con CAS su `orders.revision`.

## Interventi

- Aggiunto flag `BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY=1`.
- Il flag aggregato `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1` e l'alias roadmap `ORDERS_RELATIONAL_WRITE_PRIMARY=1` abilitano anche `correct`.
- La rotta `orders/correct` ora aggiorna prima il relazionale con CAS, poi salva il mirror app-state.
- In caso di mismatch revision relazionale viene restituito `409 REVISION_CONFLICT` e il mirror JSON non viene avanzato.
- Il comportamento applicativo della correzione resta invariato:
  - aggiunte/rimozioni/modifiche righe;
  - incremento `revision/currentRevision`;
  - stampa modifica comanda e preconto;
  - publish realtime dopo persistenza;
  - `reso senza sostituzione` resta sulla comanda corrente con righe rese preservate e neutralizzate economicamente.
- `server.js` resta sotto budget architetturale: 40.499 righe.

## Test aggiunti

- `relational-orders-correct-write-primary.e2e.test.mjs`
  - create primary + correct primary;
  - verifica `orders.revision = 2`;
  - verifica raw JSON con `currentRevision = 2` e `lastCorrectionId`;
  - verifica righe relazionali aggiornate dopo aggiunta articolo;
  - simula conflitto CAS alterando la revision relazionale dopo il lock tavolo;
  - verifica risposta `409 REVISION_CONFLICT` e mirror app-state non avanzato.

## Verifica eseguita

- `node --check cassa-frontend/backend/server.js`: OK.
- `node --check cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs`: OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-cancel-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs`: 20 pass.
- `node --test cassa-frontend/backend/tests/security.test.mjs`: 29 pass.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 16 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs`: 5 pass.
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`: 9 pass.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 6 pass.

## Stato

I4 ha completato `create`, `sync`, `cancel` e `correct` dietro flag. Resta `comp`, da trattare come ultimo sotto-step perche' tocca importi, pagabilita', sconti/omaggi e possibili effetti fiscale/pagamenti.
