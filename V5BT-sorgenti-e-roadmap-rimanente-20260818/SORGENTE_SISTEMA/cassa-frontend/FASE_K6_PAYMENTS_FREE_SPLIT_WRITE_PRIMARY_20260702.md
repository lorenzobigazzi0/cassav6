# Fase K6 - payments/free-split write-primary

Data: 2026-07-02

## Obiettivo

Promuovere `/api/payments/free-split` a write-primary relazionale per split
libero, split multi-quota e importo parziale, dietro flag:

```env
BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1
```

## Modifiche

- `backend/db/relational/payments.repo.js`
  - Aggiunto `createFreeSplitPaymentFromAppState(...)`.
  - Il metodo scrive piu' `payment_parts` e piu' `payment_transactions` per lo
    stesso container.
  - `createTicketPaymentFromAppState(...)` ora riusa il metodo multi-riga,
    mantenendo compatibilita' con K4/K5.
  - Gestito il caso a valore zero da beneficio commerciale 100% senza incasso:
    il container puo' essere registrato anche senza transazioni monetarie solo
    se totale e pagato sono entrambi zero.

- `backend/server.js`
  - Aggiunto flag `RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY`.
  - Aggiunto preflight `ensureRelationalPaymentsFreeSplitWritePrimary`.
  - Aggiunto `recordRelationalFreeSplitPayment(...)` con
    `withTransactionalOutboxEvent`.
  - Il commit atomico K6 scrive:
    - `payment_transactions`;
    - `payment_containers`;
    - `payment_parts`;
    - eventuali `fiscal_receipts`;
    - snapshot `table_states`/`table_bills` se il pagamento riguarda un tavolo;
    - outbox `payment.status`.
  - Riusato il guardrail `TABLE_DUE_INVARIANT_FAILED` per verificare che
    `table_states.total_due_cents` coincida con la somma dei
    `table_bills.due_cents`.

- `backend/modules/payments/payments.handlers.js`
  - Aggiunte dependency opzionali per K6.
  - `handlePaymentFreeSplit` fa preflight relazionale prima degli effetti.
  - Aggiunto assert esplicito prima del commit:
    - somma quote = totale dovuto calcolato;
    - somma transazioni = totale pagato calcolato;
    - importo container = totale pagato.
  - Con il flag attivo registra pagamento + snapshot tavolo + outbox atomico
    prima del mirror app-state.
  - Se `EVENT_OUTBOX_ENABLED=1`, evita il secondo enqueue non atomico e pubblica
    inline ai client SSE gia' connessi.

- `backend/tests/relational-payments-free-split-write-primary.test.mjs`
  - Test split multi-quota con due `payment_parts` e due transazioni.
  - Test importo parziale con residuo coerente su ordine, bill e tavolo.
  - Test concorrenza reale stessa idempotency key.
  - Test guardrail 503 senza DB relazionale.

## Guardrail verificati

- DB relazionale assente -> `503 RELATIONAL_PAYMENTS_DB_UNAVAILABLE`.
- Nessun doppio incasso con stessa idempotency key.
- Split multi-quota registra tutte le quote e tutte le transazioni.
- Split parziale mantiene residuo esatto nel relazionale e nel mirror app-state.
- Outbox pagamenti scritto nella stessa transazione del pagamento.
- Confine fiscale rieseguito: `payments/free-split` con RT pending non pubblica
  `payment_completed`.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-free-split-write-primary.test.mjs
```

Risultato: 4/4 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-free-split-write-primary.test.mjs backend/tests/relational-payments-table-write-primary.test.mjs backend/tests/relational-payments-ticket-write-primary.test.mjs backend/tests/relational-fiscal-command-write-primary.test.mjs backend/tests/relational-payments.test.mjs backend/tests/relational-payments-reports-read-primary.test.mjs backend/tests/relational-tables-bills.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/fiscal-optimism-boundary.e2e.test.mjs backend/tests/architecture-line-budget.test.mjs
```

Risultato: 69/69 pass.

## Metriche locali

- `backend/server.js`: 38.514 righe.
- `backend/modules/payments/payments.handlers.js`: 2.902 righe.
- Budget architetturale: test verde.

## Note operative

K6 mantiene la sequenza K4/K5:

1. preflight relazionale;
2. validazione somme split;
3. write-primary relazionale atomico con outbox;
4. mirror app-state;
5. shadow-sync che riallinea pagamenti e tavoli dal mirror.

Il caso di beneficio commerciale senza incasso rimane supportato, ma non viene
confuso con un pagamento monetario: senza transazioni e con importo diverso da
zero il repository rifiuta la scrittura.

## STOP/REVIEW

K6 completato e fermato in STOP/REVIEW come richiesto dalla roadmap.
