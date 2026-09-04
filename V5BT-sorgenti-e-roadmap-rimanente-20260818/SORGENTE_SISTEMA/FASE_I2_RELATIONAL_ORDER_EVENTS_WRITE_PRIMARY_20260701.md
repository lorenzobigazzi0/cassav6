# Fase I2 - Relational order events write-primary

Data: 2026-07-01

## Obiettivo

Introdurre un primo comando isolato e idempotente sul dominio ordini: append degli eventi `order.created` e `order.line_added` su `order_events`, lasciando l'app-state come verita' dello stato corrente della comanda.

## Implementazione

- Aggiunto modulo `cassa-frontend/backend/modules/integration/relational-order-events.js`.
- Aggiunti eventi ordine deterministici:
  - `${orderId}:order.created`
  - `${orderId}:${lineId}:order.line_added`
- Aggiunto append idempotente in `OrdersRelationalRepository.appendOrderEvents()` tramite `INSERT OR IGNORE`.
- Aggiunta lettura `OrdersRelationalRepository.listOrderEvents()`.
- `POST /api/integration/orders/create` ora puo' conservare `idempotencyKey`, `createdByDeviceUuid` ed `events` nell'ordine app-state.
- Con flag attivo, la creazione ordine salva gli eventi dentro `order.events`, cosi' il mirror shadow puo' ricostruire `order_events` in modo equivalente anche ai sync successivi.
- Dopo il commit app-state, il server prova anche l'append relazionale idempotente diretto.

## Flag

- Attivazione: `BACKEND_RELATIONAL_ORDER_EVENTS_WRITE_PRIMARY=1`
- Rollback: rimuovere il flag o impostarlo a `0`.

Con flag spento, la creazione ordine continua senza aggiungere eventi relazionali dedicati.

## Idempotenza

- `orders/create` riconosce `idempotencyKey`, `clientOrderId` o `localOrderId`.
- Un retry con la stessa chiave, stesso utente e stesso device restituisce la comanda gia' creata con `idempotent: true`.
- Gli eventi relazionali usano id deterministici e non si duplicano.

## Test aggiunti

- `append order events relazionale e idempotente`
- `[BE][I2] order create appende eventi relazionali idempotenti`

## Verifica eseguita

Comandi eseguiti con `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node`:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/db/relational/orders.repo.js`
- `node --check cassa-frontend/backend/modules/integration/relational-order-events.js`
- `node --check cassa-frontend/backend/tests/relational-orders.test.mjs`
- `node --check cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs` -> 1 pass
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs` -> 15 pass
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 11 pass
- `node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs` -> 5 pass
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs` -> 16 pass
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs` -> 9 pass
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53 pass
- `node --test cassa-frontend/backend/tests/realtime-event-outbox.e2e.test.mjs` -> 4 pass
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1 pass

`backend/server.js`: 40455 righe, sotto il budget 40500.

## Esito

Fase I2 completata. Gli eventi ordine creati da `orders/create` possono ora essere scritti in modo idempotente nel relazionale senza spostare ancora lo stato corrente della comanda fuori dall'app-state.

Prossimo step roadmap: Fase I3, aggiunta di `revision` come colonna nativa sugli ordini relazionali e preparazione CAS.
