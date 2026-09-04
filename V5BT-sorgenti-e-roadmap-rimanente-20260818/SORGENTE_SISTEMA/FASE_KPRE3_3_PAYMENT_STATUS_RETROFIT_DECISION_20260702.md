# FASE K-PRE.3.3 - Decisione retrofit payment.status

Data: 2026-07-02

## Obiettivo

Valutare se convertire subito il collegamento esistente `payment.status` al nuovo helper transazionale `withTransactionalOutboxEvent`, oppure rimandare il retrofit a K4-K6.

## Punti verificati

File letti:

- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/modules/realtime-backbone/event-outbox.js`

Siti di publish osservati:

- `payments/table`: publish `payment_completed` dopo `await writePaymentDb(db)`.
- `payments/free-split`: publish `payment_completed` oppure `payment_status_changed` dopo `await writePaymentDb(db)`.
- `payments/ticket`: publish `payment_completed` dopo `await writePaymentDb(db)`.

Il collegamento H3a attuale e' quindi ancora nel flusso legacy: persistenza app-state prima, outbox/publish dopo. Non e' atomico con la scrittura di pagamento.

## Decisione

Rimandare il retrofit a K4-K6.

Motivazione:

- `withTransactionalOutboxEvent` e' ora pronto, ma nasce per la transazione relazionale write-primary.
- Applicarlo subito ai tre handler legacy richiederebbe mescolare `writePaymentDb(db)` app-state e transazione relazionale nello stesso passaggio, aumentando il rischio prima della migrazione K.
- K4, K5 e K6 toccheranno esattamente i tre endpoint interessati (`payments/ticket`, `payments/table`, `payments/free-split`) e sono il punto naturale per sostituire il publish non atomico con il nuovo contratto.
- Il retrofit graduale mantiene il rollout leggibile: un endpoint alla volta diventa write-primary e nello stesso commit adotta outbox atomico.

## Vincolo per K4-K6

Quando verra' aperto ciascuno step K:

- K4 dovra' usare `withTransactionalOutboxEvent` per `payments/ticket`.
- K5 dovra' usare `withTransactionalOutboxEvent` per `payments/table`.
- K6 dovra' usare `withTransactionalOutboxEvent` per `payments/free-split`.
- Il vecchio publish `payment.status` post-commit non dovra' restare come percorso concorrente sullo stesso endpoint migrato.

## Esito

K-PRE.3.3 completata.

STOP/REVIEW leggero: K-PRE.3 chiusa. Il prossimo step e' K-PRE.4.1.
