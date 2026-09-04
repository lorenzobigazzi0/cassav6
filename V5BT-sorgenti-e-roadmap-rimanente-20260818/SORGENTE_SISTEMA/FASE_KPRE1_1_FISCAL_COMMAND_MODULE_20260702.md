# Fase K-PRE.1.1 - Fiscal command module

Data: 2026-07-02

## Scope

Estrazione minima di `handleFiscalCommand` dal monolite backend verso il modulo
`backend/modules/fiscal-pos/`, senza modifica di comportamento, permessi o payload
pubblici.

## File creati

- `cassa-frontend/backend/modules/fiscal-pos/fiscal.handlers.js`
- `cassa-frontend/backend/modules/fiscal-pos/fiscal.routes.js`
- `cassa-frontend/backend/modules/fiscal-pos/fiscal.domain.js`
- `cassa-frontend/backend/modules/fiscal-pos/index.js`

## File modificati

- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/routes/index.js`

## Dettaglio tecnico

- La route `POST /api/fiscal/command` e' stata spostata da registrazione diretta
  a `buildFiscalRoutes()`.
- L'handler `fiscal.command` viene ora esposto da `createFiscalHandlers()`.
- Le dipendenze sono iniettate dal `server.js` secondo l'audit K-PRE.0:
  `randomUUID`, `HttpError`, `sendJson`, `nowIso`, `appendAuditEvent`,
  `sanitizePosSettings`, `readDb`, `writePaymentDb`, `buildAuditActor`,
  `validateSessionContext`, `executeFiscalProvider`, `isPosDemoModeEnabled`,
  `readJsonBody`.
- Il comportamento demo mode, fiscal provider, audit event e persistenza su
  `writePaymentDb` e' rimasto invariato.

## Misure

- `backend/server.js`: 40496 righe prima di K-PRE.1.1, 40409 righe dopo
  l'estrazione.
- Nuovo modulo `backend/modules/fiscal-pos`: 139 righe complessive.

## Verifiche eseguite

- `node --check backend/server.js`
- `node --check backend/modules/fiscal-pos/*.js backend/routes/index.js`
- `node --test backend/tests/architecture-line-budget.test.mjs`
- `node --test backend/tests/route-policy-architecture.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test backend/tests/fiscal-receipts-domain.test.mjs`
- `node --test backend/tests/security.test.mjs`
- Registry check: una sola route `POST /api/fiscal/command`, handler
  `fiscal.command`, permesso `fiscal_operations`.

## Esito

PASS. K-PRE.1.1 completata.

## STOP / REVIEW

Come richiesto dalla roadmap, fermarsi qui prima di procedere con K-PRE.1.2
(`handlePaymentMovementReprint`).
