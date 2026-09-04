# Fase K3 - fiscal/command write-primary tecnico

Data: 2026-07-02

## Obiettivo

Implementare il primo write-primary relazionale del dominio fiscale su
`/api/fiscal/command`, limitato a un comando tecnico/retry che non modifica i
saldi pagamento.

Flag:

```env
BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY=1
```

## Modifiche

- `backend/modules/fiscal-pos/fiscal.handlers.js`
  - Aggiunto preflight relazionale prima del provider fiscale quando il flag K3
    e attivo.
  - Aggiunta registrazione relazionale dopo `writePaymentDb`, per evitare che
    lo shadow-sync JSON sovrascriva il write-primary.
  - La risposta include il riferimento relazionale solo quando il flag e attivo.

- `backend/server.js`
  - Aggiunto flag `RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY`.
  - Aggiunto recorder relazionale con `withTransactionalOutboxEvent`.
  - Il recorder:
    - cerca l'eventuale `paymentTransactionId`;
    - crea una riga `fiscal_receipts`;
    - aggiorna solo `raw_json` e `updated_at` della transazione collegata con
      CAS su `revision`;
    - accoda un evento outbox `payment.status`.
  - DB relazionale non disponibile: HTTP 503 esplicito, senza fallback
    silenzioso.

- `backend/db/relational/payments.repo.js`
  - Aggiunte API minime `getFiscalReceiptById` e `createFiscalReceipt`.

- `backend/tests/relational-fiscal-command-write-primary.test.mjs`
  - Test K3 positivo: verifica `fiscal_receipts`, outbox, CAS e invarianti su
    `total_cents`, `paid_cents`, `due_cents`, `amount_cents`.
  - Test K3 guardrail: flag acceso senza relazionale restituisce 503 e non crea
    eventi fiscali applicativi.

## Invarianti verificate

- `payment_containers.total_cents` invariato.
- `payment_containers.paid_cents` invariato.
- `payment_containers.due_cents` invariato.
- `payment_transactions.amount_cents` invariato.
- `payment_transactions.status` invariato.
- `payment_transactions.revision` incrementata solo per la traccia tecnica CAS.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-fiscal-command-write-primary.test.mjs
```

Risultato: 2/2 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments.test.mjs backend/tests/relational-payments-reports-read-primary.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/fiscal-optimism-boundary.e2e.test.mjs backend/tests/architecture-line-budget.test.mjs
```

Risultato: 45/45 pass.

## Note operative

Durante il primo test, il write relazionale fatto prima di `writePaymentDb`
veniva sovrascritto dallo shadow-sync app-state. La sequenza finale e:

1. preflight DB relazionale;
2. provider fiscale;
3. scrittura app-state;
4. write-primary relazionale con CAS e outbox.

Questo mantiene il guardrail prima del provider e conserva il write-primary dopo
lo shadow-sync.

## STOP/REVIEW

K3 completato e fermato in STOP/REVIEW come richiesto dalla roadmap.
