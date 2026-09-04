# Fase K4 - payments/ticket write-primary

Data: 2026-07-02

## Obiettivo

Promuovere `/api/payments/ticket` a primo write-primary relazionale per un
incasso reale semplice, dietro flag:

```env
BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1
```

Alias supportato:

```env
PAYMENTS_RELATIONAL_WRITE_PRIMARY=1
```

## Modifiche

- `backend/db/relational/payments.repo.js`
  - Aggiunto `createPaymentTransaction(row)`.
  - Aggiunto `createTicketPaymentFromAppState(...)`.
  - La transazione viene inserita prima di container/part, cosi' il vincolo
    `UNIQUE(payment_transactions.idempotency_key)` puo' bloccare i duplicati
    senza lasciare righe figlie orfane.
  - Su violazione `UNIQUE`, il repository rilegge la transazione esistente per
    idempotency key e la marca come replay.

- `backend/server.js`
  - Aggiunto flag `RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY`.
  - Aggiunto preflight relazionale: DB assente -> `503
    RELATIONAL_PAYMENTS_DB_UNAVAILABLE`.
  - Aggiunto `recordRelationalTicketPayment(...)` con
    `withTransactionalOutboxEvent`.
  - Il bundle relazionale crea:
    - `payment_transactions`;
    - `payment_containers`;
    - `payment_parts`;
    - eventuali `fiscal_receipts`;
    - evento atomico `payment.status`.
  - Se `EVENT_OUTBOX_ENABLED=1`, dopo il commit non viene accodata una seconda
    riga outbox non atomica: viene solo pubblicato l'evento SSE inline se ci sono
    client collegati.

- `backend/tests/relational-payments-ticket-write-primary.test.mjs`
  - Test funzionale: righe relazionali + outbox atomico.
  - Test concorrenza reale HTTP con stessa idempotency key: replay senza doppio
    incasso.
  - Test guardrail 503 senza DB relazionale.

## Note di dominio

Il path `/api/payments/ticket` corrente e' un pagamento banco/ticket senza
`billId` o `tableId`; quindi l'aggiornamento `due_cents` su bill/tavolo previsto
dalla roadmap non ha una riga di dominio da aggiornare in questo sotto-step.
Quell'invariante resta da applicare nei passi K5/K6, dove il pagamento contiene
tavolo/bill/split.

Lo shadow payments continua a fare `replaceAllFromAppState`. Per questo il
codice mantiene:

1. preflight relazionale prima di effetti di pagamento;
2. write relazionale + outbox atomico;
3. mirror app-state;
4. shadow-sync che reidrata le stesse righe dal mirror.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-ticket-write-primary.test.mjs
```

Risultato: 3/3 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-ticket-write-primary.test.mjs backend/tests/relational-fiscal-command-write-primary.test.mjs backend/tests/relational-payments.test.mjs backend/tests/relational-payments-reports-read-primary.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/fiscal-optimism-boundary.e2e.test.mjs backend/tests/architecture-line-budget.test.mjs
```

Risultato: 50/50 pass.

## Metriche locali

- `backend/server.js`: 38.239 righe.
- Budget architetturale: test verde.

## STOP/REVIEW

K4 completato e fermato in STOP/REVIEW come richiesto dalla roadmap.
