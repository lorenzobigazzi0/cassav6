# FASE K-PRE.4.2 - Fiscal optimism boundary

Data: 2026-07-02

## Obiettivo

Correggere il confine realtime tra pagamento completato economicamente e fiscalizzazione POS ancora pendente/retry, poi fissarlo con `fiscal-optimism-boundary.e2e.test.mjs`.

## Modifiche eseguite

File aggiornati:

- `cassa-frontend/backend/modules/payments/payments.domain.js`
- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/server.js`

File aggiunto:

- `cassa-frontend/backend/tests/fiscal-optimism-boundary.e2e.test.mjs`

Dettaglio:

- Aggiunto lo stato realtime `PENDING_FISCAL`.
- Aggiunto `buildPaymentRealtimeBoundary(...)` per scegliere tra `payment_completed` e `payment_status_changed`.
- Aggiunto `isFiscalReceiptIssued(...)` per distinguere una ricevuta fiscale emessa da una ricevuta POS solo tracciata/pending.
- `payments/table`: non registra piu' `fiscal.issued` su receipt POS `PENDING`; pubblica `payment_status_changed` con `PENDING_FISCAL` se il fiscale e' aperto.
- `payments/free-split`: quando il saldo e' completo ma il fiscale POS e' pending/retry, pubblica `payment_status_changed` con `PENDING_FISCAL`; mantiene anche `economicPaymentStatus: "COMPLETED"` nel dettaglio realtime.
- `payments/ticket`: stesso confine di `payments/table`, senza `payment_completed` ottimistico in presenza di fiscale aperto.

## Test aggiunto

`backend/tests/fiscal-optimism-boundary.e2e.test.mjs` copre:

- fiscale sincrono riuscito: `payment_completed` solo con `fiscal.issued` gia' presente;
- metodo non fiscale: flusso rapido con `payment_completed`;
- `payments/table` con RT POS pending: `payment_status_changed` + `PENDING_FISCAL`, non `payment_completed`;
- `payments/free-split` con RT POS pending: `payment_status_changed` + `PENDING_FISCAL`, non `payment_completed`;
- `payments/ticket` con RT POS pending: `payment_status_changed` + `PENDING_FISCAL`, non `payment_completed`.

## Verifiche eseguite

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/payments/payments.domain.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/payments/payments.handlers.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/fiscal-optimism-boundary.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/fiscal-optimism-boundary.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-event-outbox.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payment-weird-cases.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/pos-fiscal-retry.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/orders-payments-invariants.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/fiscal-receipts-domain.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Risultati:

- `fiscal-optimism-boundary.e2e.test.mjs`: 5/5 verdi.
- `payments-fiscal.e2e.test.mjs`: 16/16 verdi.
- `realtime-event-outbox.e2e.test.mjs`: 4/4 verdi.
- `payment-weird-cases.e2e.test.mjs`: 15/15 verdi.
- `pos-fiscal-retry.e2e.test.mjs`: 4/4 verdi.
- `orders-payments-invariants.test.mjs`: 17/17 verdi.
- `relational-payments.test.mjs`: 12/12 verdi.
- `fiscal-receipts-domain.test.mjs`: 4/4 verdi.
- `architecture-line-budget.test.mjs`: 1/1 verde.
- `backend/server.js`: 37943 righe, sotto budget.

## Esito

K-PRE.4.2 completata.

STOP/REVIEW: rispettato. Il prossimo step e' K-PRE.4.3.
