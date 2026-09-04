# Fase K7 - fiscal_receipts write-primary

Data: 2026-07-02

## Obiettivo

Blindare la prenotazione/emissione fiscale relazionale evitando doppie righe
`fiscal_receipts` per la stessa transazione e lo stesso tentativo fiscale,
dietro flag:

```env
BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1
```

## Modifiche

- `backend/db/relational/migrations/016_fiscal_receipts_attempt_scope.sql`
  - Aggiunta colonna `attempt_scope` con default `issue`.
  - Aggiunto indice unico:
    `UNIQUE(payment_transaction_id, attempt_scope)` per righe con
    `payment_transaction_id` valorizzato.
  - Le eventuali righe legacy duplicate vengono marcate con scope
    `legacy_<rowid>` prima della creazione dell'indice, cosi' la migrazione non
    fallisce su storico gia' sporco.

- `backend/db/relational/payments.repo.js`
  - Aggiunto mapping `attemptScope`.
  - Aggiunto `getFiscalReceiptByPaymentAttempt(...)`.
  - `createFiscalReceipt(...)` ora e' idempotente sul vincolo
    transazione/scope: in caso di duplicato restituisce la ricevuta gia'
    registrata.
  - Corretto il mapping FK delle ricevute POS: quando `receipt.paymentId`
    contiene l'id transazione, viene usato per valorizzare
    `payment_transaction_id`.

- `backend/server.js`
  - Aggiunto flag `RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY`.
  - Aggiunto `ensureRelationalFiscalReceiptsWritePrimary(...)`.
  - Se K7 e' attivo e un ticket fiscale non sta usando
    `BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1`, la richiesta viene
    bloccata prima di accodare la ricevuta fiscale.
  - I comandi fiscali tecnici K3 usano uno scope separato
    `command:<comando>`, cosi' non collidono con l'emissione originale
    `issue`.

- `backend/modules/payments/payments.handlers.js`
  - Aggiunte dependency K7.
  - Pagamento tavolo e free-split fanno preflight K7 se devono creare una
    ricevuta fiscale.
  - Con K7 attivo non esiste fallback che emetta/accodi fiscalita senza
    tracciamento relazionale del pagamento.

- `backend/db/relational/equivalence.js`
  - Inclusa `attempt_scope` nell'equivalenza payments/fiscal, cosi' K0 resta
    simmetrico dopo la nuova colonna.

- `backend/tests/relational-fiscal-receipts-write-primary.test.mjs`
  - Test repository sul vincolo `attempt_scope`.
  - Test ticket fiscale POS con una sola ricevuta `issue`.
  - Test concorrenza reale con stessa idempotency key: una sola ricevuta.
  - Test guardrail: K7 senza write-primary pagamento restituisce 503.

## Guardrail verificati

- DB relazionale fiscale assente -> `503 RELATIONAL_FISCAL_DB_UNAVAILABLE`.
- K7 attivo senza write-primary pagamento -> `503 RELATIONAL_FISCAL_PAYMENT_WRITE_PRIMARY_REQUIRED`.
- Doppia creazione stessa transazione/scope -> replay della ricevuta esistente.
- Ricevute POS agganciate a `payment_transactions`, non orfane.
- Ristampa resta fuori dal path generativo: non e' stato aggiunto nessun insert
  `fiscal_receipts` nel flusso reprint.
- Confine fiscale rieseguito: con RT pending non parte `payment_completed`.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-fiscal-receipts-write-primary.test.mjs
```

Risultato: 4/4 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments.test.mjs
```

Risultato: 19/19 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-fiscal-receipts-write-primary.test.mjs backend/tests/relational-payments-free-split-write-primary.test.mjs backend/tests/relational-payments-table-write-primary.test.mjs backend/tests/relational-payments-ticket-write-primary.test.mjs backend/tests/relational-fiscal-command-write-primary.test.mjs backend/tests/relational-payments.test.mjs backend/tests/relational-payments-reports-read-primary.test.mjs backend/tests/relational-tables-bills.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/fiscal-optimism-boundary.e2e.test.mjs backend/tests/architecture-line-budget.test.mjs
```

Risultato: 73/73 pass.

## Metriche locali

- `backend/server.js`: 38.545 righe.
- `backend/modules/payments/payments.handlers.js`: 2.924 righe.
- `backend/db/relational/payments.repo.js`: 1.051 righe.
- Budget architetturale: test verde.

## Note operative

K7 non cambia l'adapter RT: protegge il tracciamento relazionale prima che un
pagamento fiscale possa accodare/emissionare una ricevuta. Per attivarlo in
produzione va acceso insieme al write-primary del pagamento interessato
(`ticket`, `table`, `free-split`), altrimenti il guardrail blocca la richiesta.

## STOP/REVIEW

K7 completato e fermato in STOP/REVIEW come richiesto dalla roadmap.
