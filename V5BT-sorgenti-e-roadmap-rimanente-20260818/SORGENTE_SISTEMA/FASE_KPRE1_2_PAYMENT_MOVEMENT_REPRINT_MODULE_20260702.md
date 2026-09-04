# Fase K-PRE.1.2 - Payment movement reprint module

Data: 2026-07-02

## Scope

Estrazione minima di `handlePaymentMovementReprint` dal monolite backend verso
il modulo `backend/modules/payments/`, senza modifica di comportamento,
endpoint pubblico o payload.

## File creati

- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/modules/payments/payments.routes.js`
- `cassa-frontend/backend/modules/payments/payments.domain.js`
- `cassa-frontend/backend/modules/payments/index.js`

## File modificati

- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/routes/index.js`
- `cassa-frontend/backend/modules/reports/reports.routes.js`

## Dettaglio tecnico

- La route `POST /api/reports/payment-movement/reprint` e' stata spostata da
  `buildReportsRoutes()` a `buildPaymentRoutes()`.
- L'handler key resta invariato: `reports.paymentMovementReprint`.
- L'handler viene ora esposto da `createPaymentHandlers()`.
- Le dipendenze sono iniettate dal `server.js` secondo l'audit K-PRE.0:
  `HttpError`, `sendJson`, `nowIso`, `appendAuditEvent`,
  `ensurePaymentTrackingArrays`, `readDb`, `writePaymentDb`,
  `buildAuditActor`, `validateSessionContext`, `queuePrintSpoolWorker`,
  `schedulePosFiscalReprintBackgroundJobs`, `hasConfiguredPosFiscalApiDevice`,
  `readJsonBody`, `ensureIntegrationOrderComps`,
  `normalizePaymentMovementId`, `normalizePaymentMovementAdvancedDetails`,
  `enqueuePaymentMovementAdvancedPrintJobToDb`,
  `findPaymentReprintContainer`, `enqueuePaymentMovementReprintJobsToDb`,
  `buildPosFiscalReprintJobsForPaymentContainer`,
  `appendQueuedPosFiscalReprintEvents`, `findPaymentStornoCompRecord`,
  `canReprintPaymentMovement`, `enqueueStornoMovementReprintJobToDb`.
- Il comportamento di stampa avanzata, ristampa movimento, accodamento
  ristampe fiscali, audit e persistenza su `writePaymentDb` e' rimasto
  invariato.

## Misure

- `backend/server.js`: 40409 righe prima di K-PRE.1.2, 40262 righe dopo
  l'estrazione.
- Nuovo modulo `backend/modules/payments`: 223 righe per quartetto K-PRE.1.2.

## Verifiche eseguite

- `node --check backend/server.js`
- `node --check backend/modules/payments/*.js backend/routes/index.js backend/modules/reports/reports.routes.js`
- `node --test backend/tests/architecture-line-budget.test.mjs`
- `node --test backend/tests/route-policy-architecture.test.mjs`
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/payment-provider-transactions.test.mjs`
- `node --test backend/tests/orders-payments-invariants.test.mjs`
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test backend/tests/security.test.mjs`
- Registry check: una sola route `POST /api/reports/payment-movement/reprint`,
  handler `reports.paymentMovementReprint`, mutation `true`, auth richiesta.

## Esito

PASS. K-PRE.1.2 completata.

## STOP / REVIEW

Come richiesto dalla roadmap, fermarsi qui prima di procedere con K-PRE.1.3
(`handlePayTable`).
