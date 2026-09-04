# FASE K-PRE.4.1 - Verifica confine fiscale realtime

Data: 2026-07-02

## Obiettivo

Verificare i tre punti di publish `payment.status` prima di scrivere il test automatico `fiscal-optimism-boundary.e2e.test.mjs`.

## File verificati

- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/server.js`

## Sintesi

Esito: il confine fiscale non e' corretto nello stato attuale. Tutti e tre i siti richiedono una correzione prima di K-PRE.4.2.

Il problema comune e' che il pagamento viene segnalato come `payment_completed` quando la parte fiscale POS puo' essere ancora `PENDING` oppure in retry. Per K-PRE.4.2 serve introdurre uno stato realtime intermedio esplicito, ad esempio `PENDING_FISCAL`, pubblicato come `payment_status_changed` fino a quando l'esito RT non e' davvero noto.

## Sito 1 - `payments/table`

File: `cassa-frontend/backend/modules/payments/payments.handlers.js`

Punti letti:

- `shouldIssuePosFiscalReceipt` calcolato prima della scrittura pagamento.
- `maybeIssuePosFiscalReceipt(..., deferSchedule: true)` puo' restituire:
  - `issued: false`
  - `pending: true`
  - `receipt` con `fiscalStatus: "PENDING"`
  - `backgroundJob`
- Se `posFiscalResult?.receipt` esiste, il codice assegna `receipt`.
- Il blocco audit usa `if (receipt)` e registra `fiscal.issued`.
- Dopo `await writePaymentDb(db)`, il codice pubblica sempre `payment_completed`.

Giudizio: **richiede correzione prima di K-PRE.4.2**.

Motivo:

- Un `receipt` POS `PENDING` non equivale a emissione fiscale riuscita.
- Il ramo `if (receipt)` puo' produrre `fiscal.issued` anche quando `posFiscalResult.issued !== true`.
- Il publish realtime e' sempre `payment_completed`, anche se `posFiscalResult?.requiresRetry === true` o l'esito e' ancora pending.

## Sito 2 - `payments/free-split`

File: `cassa-frontend/backend/modules/payments/payments.handlers.js`

Punti letti:

- `paymentStatus` e' calcolato solo da `totalPaid >= totalDue`.
- I risultati POS fiscal vengono raccolti in `posFiscalResults`.
- `shouldReleaseTable` blocca la liberazione solo se esiste `requiresRetry === true`, ma non se il fiscale e' `pending`.
- Dopo `await writePaymentDb(db)`, il codice pubblica `payment_completed` quando `paymentStatus === "COMPLETED"`.

Giudizio: **richiede correzione prima di K-PRE.4.2**.

Motivo:

- La scelta tra `payment_completed` e `payment_status_changed` non considera `posFiscalResults`.
- Un pagamento economicamente completo ma fiscalmente pending viene pubblicato come completato.
- Il ramo e' gia' piu' adatto degli altri due perche' ha una scelta dinamica, ma la variabile che la guida non include il confine fiscale.

## Sito 3 - `payments/ticket`

File: `cassa-frontend/backend/server.js`

Punti letti:

- `maybeIssuePosFiscalReceipt(..., deferSchedule: true)` puo' restituire un `receipt` POS `PENDING`.
- Se `posFiscalResult?.receipt` esiste, il codice assegna `receipt`.
- Il blocco audit usa `if (receipt)` e registra `fiscal.issued`.
- Dopo `await writePaymentDb(db)`, il codice pubblica sempre `payment_completed`.

Giudizio: **richiede correzione prima di K-PRE.4.2**.

Motivo:

- Come in `payments/table`, un record fiscale POS `PENDING` viene trattato come ricevuta emessa.
- Il publish realtime resta `payment_completed` anche quando `fiscalRecoveryRequired` nella risposta HTTP sarebbe `true`.

## Correzione richiesta prima/dentro K-PRE.4.2

K-PRE.4.2 non puo' essere solo test. Deve includere anche il fix minimo:

- distinguere `receipt` tracciata da `receipt` emessa;
- registrare `fiscal.issued` solo quando l'esito fiscale e' davvero emesso (`issued === true` o `fiscalStatus === "ISSUED"` senza retry);
- calcolare uno stato realtime fiscale, ad esempio `PENDING_FISCAL`, quando esiste POS fiscale pending/retry;
- pubblicare `payment_status_changed` con quello stato intermedio invece di `payment_completed`;
- pubblicare `payment_completed` solo quando il pagamento e' economicamente completo e il confine fiscale e' chiuso;
- applicare la stessa regola ai tre endpoint prima di aprire K4.

## Esito

K-PRE.4.1 completata.

STOP/REVIEW: condividere questo esito prima di scrivere `fiscal-optimism-boundary.e2e.test.mjs`.
