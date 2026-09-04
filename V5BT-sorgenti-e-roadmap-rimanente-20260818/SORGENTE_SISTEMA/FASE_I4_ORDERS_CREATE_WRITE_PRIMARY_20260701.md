# Fase I4 - Orders Create Write-Primary Relazionale - 2026-07-01

## Obiettivo

Avviare il passo I4 della `ROADMAP_REALTIME_CASSAV4_v3.md` con il sotto-step piu' prudente: `POST /api/integration/orders/create` scrive l'ordine nel relazionale come primary, mantenendo app-state come mirror e fallback di rollout.

## Interventi

- Aggiunto flag `BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1`.
- Supportati anche `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1` e `ORDERS_RELATIONAL_WRITE_PRIMARY=1` come alias di rollout.
- Aggiunto modulo `modules/integration/relational-order-create.js`:
  - richiede esplicitamente il DB relazionale quando il flag e' attivo;
  - cerca retry idempotenti nel relazionale;
  - crea il grafo ordine relazionale;
  - ripara il mirror app-state se un retry trova l'ordine nel relazionale ma non nello stato documentale.
- Esteso `OrdersRelationalRepository` con:
  - `createOrder(order)`;
  - `findOrderByIdempotencyKey(key, { userId, deviceUuid })`.
- Il flusso `orders/create` ora:
  - controlla prima idempotenza app-state;
  - se il flag e' attivo, controlla idempotenza relazionale;
  - costruisce l'ordine completo con eventi `order.created`/`order.line_added`;
  - scrive il relazionale prima del mirror app-state;
  - evita il doppio append eventi I2 quando il create primary ha gia' scritto il grafo.
- `server.js` resta sotto budget architetturale: 40.497 righe.

## Test aggiunti

- `relational-orders.test.mjs`
  - `createOrder inserisce grafo ordine relazionale`;
  - `findOrderByIdempotencyKey rispetta utente e device`.
- `relational-orders-create-write-primary.e2e.test.mjs`
  - crea ordine con flag I4;
  - verifica righe `orders`, `order_lines`, `order_events`;
  - simula perdita del mirror app-state;
  - retry con stessa idempotency key recupera dal relazionale, ripara app-state e avanza la sequence.

## Verifica eseguita

- `node --check` su repository, modulo I4, server e test: OK.
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs`: 19 pass.
- `node --test cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs`: 1 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53 pass.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 16 pass.
- `node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs`: 5 pass.
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs`: 9 pass.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 6 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.

## Stato

I4 e' iniziata e il sotto-step `create` e' completato dietro flag. Prossimo sotto-step: `orders/sync` write-primary relazionale con CAS su `revision`, lasciando `correct/cancel/comp` per ultimi.
