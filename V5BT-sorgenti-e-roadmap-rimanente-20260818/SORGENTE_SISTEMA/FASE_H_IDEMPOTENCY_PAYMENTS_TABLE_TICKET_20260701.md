# Fase H2b - Idempotency store su pagamento tavolo e ticket

Data: 2026-07-01

## Obiettivo

Estendere il coordinator introdotto in H2a anche a:

- `POST /api/payments/table`
- `POST /api/payments/ticket`

Restano invariati:

- flag spento di default;
- fallback storico su `paymentContainers.idempotencyKey`;
- transazioni provider gia' esistenti;
- risposta API degli endpoint quando non si tratta di replay.

## Flag

Attivazione:

```bash
IDEMPOTENCY_STORE_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
```

## Comportamento

Per `payment.table`, `payment.ticket` e `payment.free_split`:

- apertura claim su `idempotency_keys` prima degli effetti;
- replay immediato se la key ha gia' stato `completed`;
- `409 IDEMPOTENCY_KEY_CONFLICT` se la stessa key arriva con payload diverso;
- `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` se la key e' ancora in lavorazione;
- `completed` salvato solo dopo persistenza della risposta;
- `failed` salvato se il flusso fallisce dopo la claim.

Per i ticket senza key client esplicita resta valido il comportamento precedente: il server genera una key interna. Il replay utile lato rete resta quello con `idempotencyKey`/`clientPaymentId` fornito dal client.

## Test aggiunti

In `cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs`:

- `idempotency store pagamento tavolo riproduce risposta e non duplica`
- `idempotency store pagamento tavolo blocca stessa key con payload diverso`
- `idempotency store ticket banco riproduce risposta e non duplica`
- `idempotency store ticket banco blocca stessa key con payload diverso`

## Verifiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/payments-fiscal.e2e.test.mjs
```

Esito: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
```

Esito:

```text
tests 15
pass 15
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
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
```

Esito:

```text
tests 6
pass 6
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

`backend/server.js`: 40.222 righe, sotto il budget G1 di 40.500.

## Stato

H2 completata per i tre flussi pagamento principali:

- tavolo;
- ticket/banco;
- free-split.

Prossimo step consigliato: H3, collegare l'`event_outbox` al primo evento SSE, partendo da `payment.status`/`payment.completed`, mantenendo il publish inline come fallback finche' `EVENT_OUTBOX_ENABLED=0`.
