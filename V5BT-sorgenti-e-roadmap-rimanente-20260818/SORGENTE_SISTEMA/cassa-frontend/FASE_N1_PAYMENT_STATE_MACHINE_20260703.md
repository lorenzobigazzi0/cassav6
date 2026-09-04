# Fase N1 - payment state machine esplicita

Data: 2026-07-03

## Obiettivo

Aprire la Fase N introducendo una state machine esplicita per i pagamenti, il
dominio piu' urgente indicato dalla roadmap.

La macchina formalizza la sequenza:

`created -> pending_provider -> authorized -> settled -> fiscal_queued -> fiscal_ok | fiscal_ko_retryable | fiscal_ko_expired -> reversed`

e rende le transizioni invalide errori espliciti invece di fallback silenziosi.

## Modifiche

- `backend/modules/payments/payment-state-machine.js`
  - Aggiunti stati canonici pagamento.
  - Aggiunti `canTransitionPaymentState()` e `applyPaymentStateTransition()`.
  - Aggiunto errore `INVALID_PAYMENT_STATE_TRANSITION`.
  - Aggiunta proiezione runtime da risultati fiscali POS/legacy:
    - nessun fiscale: `settled`;
    - PENDING/PROCESSING/QUEUED: `fiscal_queued`;
    - retry richiesto: `fiscal_ko_retryable`;
    - EXPIRED/FAILED_FINAL: `fiscal_ko_expired`;
    - ISSUED: `fiscal_ok`.

- `backend/modules/payments/payments.domain.js`
  - `buildPaymentRealtimeBoundary()` usa la state machine per proiettare
    `paymentState` e `paymentStatePath`.
  - I campi legacy `paymentStatus`, `fiscalPending` e
    `fiscalRecoveryRequired` restano invariati.

- `backend/modules/payments/payments.handlers.js`
  - Gli eventi realtime `payment.status` includono `paymentState` e
    `paymentStatePath`.
  - Il boundary riceve `paymentStateMachineEnabled`.

- `backend/server.js`
  - Aggiunto flag canary default-on:
    - `PAYMENT_STATE_MACHINE_ENABLED=0`
  - Il flag viene passato alla factory degli handler pagamenti.

- `backend/modules/payments/index.js`
  - Esportata la nuova state machine.

- Test:
  - `backend/tests/payment-state-machine.test.mjs`
  - `backend/tests/route-policy-architecture.test.mjs`

## Invarianti mantenuti

- Nessuna route cambiata.
- Nessun formato storico rimosso.
- `COMPLETED`, `OPEN` e `PENDING_FISCAL` restano i valori realtime legacy.
- La fiscal boundary continua a impedire `payment_completed` quando il fiscale
  POS e' pending/retry.
- Il flag permette rollback logico della proiezione canonica senza cambiare gli
  handler.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/payments/payment-state-machine.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/payments/payments.domain.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/payments/payments.handlers.js
```

Risultato: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/payment-state-machine.test.mjs cassa-frontend/backend/tests/payment-provider-transactions.test.mjs cassa-frontend/backend/tests/fiscal-optimism-boundary.e2e.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Risultato: 38/38 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs cassa-frontend/backend/tests/payment-weird-cases.e2e.test.mjs cassa-frontend/backend/tests/relational-payments-table-write-primary.test.mjs cassa-frontend/backend/tests/relational-payments-free-split-write-primary.test.mjs
```

Risultato: 39/39 pass.

## Verifica operativa consigliata

Nel monitor/SSE controllare gli eventi `payment.status`:

- pagamento non fiscale completato: `paymentStatus=COMPLETED`,
  `paymentState=settled`;
- fiscale POS pending: `paymentStatus=PENDING_FISCAL`,
  `paymentState=fiscal_queued`;
- fiscale POS emesso: `paymentState=fiscal_ok`;
- fiscale retry: `paymentState=fiscal_ko_retryable`.

## STOP/REVIEW

N1 e' chiusa. La Fase N resta aperta: mancano ancora state machine esplicite in
produzione per Ordine e Stampa prima del DoD complessivo.
