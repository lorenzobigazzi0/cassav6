# Fase K5 - payments/table write-primary

Data: 2026-07-02

## Obiettivo

Promuovere `/api/payments/table` a write-primary relazionale per il pagamento
tavolo, incluso il caso multi-bill, dietro flag:

```env
BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=1
```

## Modifiche

- `backend/db/relational/payments.repo.js`
  - Aggiunto `createTablePaymentFromAppState(...)`, riusando il bundle
    container/part/transaction gia' validato in K4.

- `backend/server.js`
  - Aggiunto flag `RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY`.
  - Aggiunto preflight `ensureRelationalPaymentsTableWritePrimary`.
  - Aggiunto `recordRelationalTablePayment(...)` con
    `withTransactionalOutboxEvent`.
  - Il commit atomico K5 scrive:
    - `payment_transactions`;
    - `payment_containers`;
    - `payment_parts`;
    - eventuali `fiscal_receipts`;
    - snapshot `table_states`/`table_bills` del tavolo coinvolto;
    - outbox `payment.status`.
  - Aggiunto guardrail `TABLE_DUE_INVARIANT_FAILED`: nel relazionale
    `table_states.total_due_cents` deve coincidere con la somma dei
    `table_bills.due_cents` aperti.

- `backend/modules/payments/payments.handlers.js`
  - Aggiunte dependency opzionali per K5.
  - `handlePayTable` fa preflight relazionale prima degli effetti.
  - Con il flag attivo registra pagamento + snapshot tavolo + outbox atomico
    prima del mirror app-state.
  - Se `EVENT_OUTBOX_ENABLED=1`, evita il secondo enqueue non atomico e pubblica
    solo inline ai client SSE gia' connessi.

- `backend/tests/relational-payments-table-write-primary.test.mjs`
  - Test pagamento tavolo write-primary.
  - Test concorrenza reale stessa idempotency key.
  - Test due bill diversi dello stesso tavolo pagati in parallelo.
  - Test guardrail 503 senza DB relazionale.

## Guardrail verificati

- DB relazionale assente -> `503 RELATIONAL_PAYMENTS_DB_UNAVAILABLE`.
- Nessun doppio incasso con stessa idempotency key.
- Due bill diversi dello stesso tavolo non si sovrascrivono.
- Residuo tavolo relazionale coerente con i bill aperti.
- Confine fiscale esistente rieseguito: payment completed non parte prima
  dell'esito fiscale quando c'e' RT pending.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-table-write-primary.test.mjs
```

Risultato: 4/4 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-table-write-primary.test.mjs backend/tests/relational-payments-ticket-write-primary.test.mjs backend/tests/relational-fiscal-command-write-primary.test.mjs backend/tests/relational-payments.test.mjs backend/tests/relational-payments-reports-read-primary.test.mjs backend/tests/relational-tables-bills.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/fiscal-optimism-boundary.e2e.test.mjs backend/tests/architecture-line-budget.test.mjs
```

Risultato: 65/65 pass.

## Metriche locali

- `backend/server.js`: 38.385 righe.
- Budget architetturale: test verde.

## Note operative

K5 mantiene lo stesso ordine K4:

1. preflight relazionale;
2. write-primary relazionale atomico con outbox;
3. mirror app-state;
4. shadow-sync che riallinea pagamenti e tavoli dal mirror.

Questo evita fallback silenziosi e mantiene il relazionale coerente anche dopo
la sincronizzazione shadow.

## STOP/REVIEW

K5 completato e fermato in STOP/REVIEW come richiesto dalla roadmap.
