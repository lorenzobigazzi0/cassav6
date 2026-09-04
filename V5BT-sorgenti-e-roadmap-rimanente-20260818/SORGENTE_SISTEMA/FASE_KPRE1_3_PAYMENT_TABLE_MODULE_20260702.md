# Fase K-PRE.1.3 - Payment table module

Data: 2026-07-02

## Scope

Estrazione minima di `handlePayTable` dal monolite backend verso
`backend/modules/payments/payments.handlers.js`, accanto a
`handlePaymentMovementReprint`, senza modifica di comportamento, endpoint
pubblico o payload.

## File modificati

- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/routes/index.js`
- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/modules/payments/payments.routes.js`

## Dettaglio tecnico

- La route `POST /api/payments/table` e' stata spostata da registrazione
  diretta in `routes/index.js` a `buildPaymentRoutes()`.
- L'handler key resta invariato: `payments.table`.
- L'handler viene ora esposto da `createPaymentHandlers()`.
- `paymentTransactionRepository` e' stato inizializzato prima della factory
  pagamenti, perche' `handlePayTable` lo usa come dipendenza runtime.
- Le dipendenze sono state iniettate dal `server.js` secondo l'audit K-PRE.0,
  con aggiunta esplicita di `buildPosSettingsPayload` rilevata durante lo
  spostamento runtime.
- Il comportamento di idempotenza, lock tavolo, split, provider POS, fiscalita',
  audit, aggiornamento comande e stampa ricevute e' rimasto invariato.

## Valutazione helper puri

Valutata l'estrazione in `payments.domain.js`, ma non applicata in questo step:
`handlePayTable` usa molte funzioni condivise con gli altri flussi pagamenti e
fiscali ancora nel monolite. Per rispettare il guardrail "nessun cambio di
comportamento", K-PRE.1.3 resta un refactoring meccanico con dependency
injection. L'eventuale isolamento di funzioni pure e' piu' opportuno in
K-PRE.1.4, insieme allo split libero, dove la roadmap prevede espressamente
nuovi test unitari se si separa logica di calcolo.

## Misure

- `backend/server.js`: 40262 righe prima di K-PRE.1.3, 39316 righe dopo
  l'estrazione.
- `backend/modules/payments/payments.handlers.js`: 1269 righe dopo K-PRE.1.3.

## Verifiche eseguite

- `node --check backend/server.js`
- `node --check backend/modules/payments/*.js backend/routes/index.js`
- `node --test backend/tests/architecture-line-budget.test.mjs`
- `node --test backend/tests/route-policy-architecture.test.mjs`
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/payment-provider-transactions.test.mjs`
- `node --test backend/tests/orders-payments-invariants.test.mjs`
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test backend/tests/security.test.mjs`
- Registry check: una sola route per ciascuno degli endpoint
  `/api/payments/table`, `/api/payments/ticket`, `/api/payments/free-split`,
  `/api/reports/payment-movement/reprint`.

## Esito

PASS. K-PRE.1.3 completata.

## STOP / REVIEW

Come richiesto dalla roadmap, fermarsi qui prima di procedere con K-PRE.1.4
(`handlePaymentFreeSplit`).
