# Fase H2 - Idempotency store sui pagamenti

Data: 2026-07-01

## Obiettivo

Collegare il nuovo `idempotency_keys` store della Fase H al primo flusso pagamento operativo, mantenendo il rollout dietro flag.

La tranche implementata copre `/api/payments/free-split`, cioe' il flusso piu' usato dal mobile per incassi tavolo/split e quello piu' esposto a doppio tap o retry rete.

## Flag

Il comportamento nuovo e' attivo solo con:

```bash
IDEMPOTENCY_STORE_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
```

Default: spento.

## Implementazione

Nuovo modulo:

- `cassa-frontend/backend/modules/realtime-backbone/payment-idempotency.js`

Wiring in:

- `cassa-frontend/backend/server.js`

Comportamento:

- prima degli effetti del pagamento, il backend apre una claim su `idempotency_keys`;
- se la stessa key ha gia' una risposta `completed`, il backend risponde subito con quella risposta e `idempotencyStore: true`;
- se la stessa key viene riusata con payload diverso, risponde `409 IDEMPOTENCY_KEY_CONFLICT`;
- se la stessa key e' ancora `processing`, risponde `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`;
- se il pagamento va a buon fine, la risposta viene salvata come `completed`;
- se il flusso fallisce dopo la claim, la key viene marcata `failed`.

Il vecchio controllo ad-hoc su `paymentContainers.idempotencyKey` resta come fallback e compatibilita' per dati storici o flag spento.

## Test aggiunti

In `cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs`:

- `idempotency store free split completa e riproduce la risposta`
- `idempotency store free split blocca stessa key con payload diverso`

## Verifiche eseguite

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/realtime-backbone/payment-idempotency.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/payments-fiscal.e2e.test.mjs
```

Esito: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
```

Esito:

```text
tests 11
pass 11
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
```

Esito:

```text
tests 6
pass 6
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/orders-payments-invariants.test.mjs
```

Esito:

```text
tests 16
pass 16
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

`backend/server.js`: 40.175 righe, ancora sotto il budget G1 di 40.500.

## Stato

H2a completata per `/api/payments/free-split`.

Prossimo step consigliato: estendere lo stesso coordinator a `/api/payments/table` e `/api/payments/ticket`, poi passare all'outbox eventi SSE per `payment.status`.
