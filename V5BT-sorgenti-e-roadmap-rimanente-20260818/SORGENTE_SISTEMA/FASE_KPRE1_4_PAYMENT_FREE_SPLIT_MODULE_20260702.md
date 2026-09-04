# Fase K-PRE.1.4 - Payment free split module

Data: 2026-07-02

## Scope

Estrazione minima di `handlePaymentFreeSplit` dal monolite backend verso
`backend/modules/payments/payments.handlers.js`, nello stesso modulo di
`handlePayTable` e `handlePaymentMovementReprint`, senza modifica di
comportamento, endpoint pubblico o payload.

## File modificati

- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/routes/index.js`
- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/modules/payments/payments.routes.js`

## Dettaglio tecnico

- La route `POST /api/payments/free-split` e' stata spostata da registrazione
  diretta in `routes/index.js` a `buildPaymentRoutes()`.
- L'handler key resta invariato: `payments.freeSplit`.
- L'handler viene ora esposto da `createPaymentHandlers()`.
- Le dipendenze sono state iniettate dal `server.js` secondo l'audit K-PRE.0.
- Durante la verifica e' stata aggiunta esplicitamente anche
  `appendPosFiscalEvent`, usata dal ramo di fiscalita mobile disabilitata e non
  emersa nella lista iniziale dell'audit.
- Il comportamento di idempotenza, split libero, split articolo, fiscal replay,
  benefici commerciali, provider POS, fiscalita POS/legacy, audit, aggiornamento
  tavoli e stampa ricevute e' rimasto invariato.

## Valutazione helper puri

Valutata l'estrazione di logica split in `payments.domain.js`, ma non applicata
in questo step. `handlePaymentFreeSplit` e' ancora fortemente intrecciato con
stato DB, fiscalita, idempotenza, provider POS, benefici commerciali e
aggiornamento tavoli. Per rispettare il guardrail "nessun cambio di
comportamento osservabile", K-PRE.1.4 resta un refactoring meccanico. Non sono
stati aggiunti test unitari nuovi perche' non sono state create nuove funzioni
pure.

## Misure

- `backend/server.js`: 39316 righe prima di K-PRE.1.4, 37931 righe dopo
  l'estrazione.
- `backend/modules/payments/payments.handlers.js`: 2703 righe dopo K-PRE.1.4.
- I quattro handler K-PRE.1.1 -> K-PRE.1.4 non sono piu' definiti in
  `backend/server.js`.

## Verifiche eseguite

- `node --check backend/server.js`
- `node --check backend/modules/payments/*.js backend/routes/index.js`
- `node --test backend/tests/architecture-line-budget.test.mjs`
- `node --test backend/tests/route-policy-architecture.test.mjs`
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/payment-provider-transactions.test.mjs`
- `node --test backend/tests/orders-payments-invariants.test.mjs`
- `node --test backend/tests/commercial-benefits.test.mjs`
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test backend/tests/security.test.mjs`
- Registry check: una sola route per ciascuno degli endpoint
  `/api/payments/table`, `/api/payments/ticket`, `/api/payments/free-split`,
  `/api/reports/payment-movement/reprint`.

## Esito

PASS. K-PRE.1.4 completata.

## STOP / REVIEW

Come richiesto dalla roadmap, fermarsi qui prima di procedere con K-PRE.1.5
(verifica finale del margine).
