# Phase 0 Gate Results v4.1.0

Data: 2026-06-29

Runtime usata:

```text
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin
```

Nota ambiente:

- `node` e `git` non sono nel `PATH` globale della shell.
- I comandi Node/NPM sono stati eseguiti con la runtime locale del workspace.
- Lo stato git non e' stato raccolto perche' il comando `git` non e' disponibile.

## Comandi eseguiti

### Baseline report

```bash
node scripts/architecture-health-report.mjs
```

Risultato:

- OK.
- Route registrate: 173.
- Moduli backend: 27.
- Righe `backend/server.js`: 38.359.
- Debiti architetturali rilevati: 6.

Artefatti:

- `docs/architecture/PHASE0_BASELINE_v4.1.0.md`
- `docs/architecture/phase0-baseline-v4.1.0.json`
- `docs/architecture/route-map-v4.1.0.json`
- `docs/architecture/db-domain-map-v4.1.0.json`
- `docs/architecture/config-surface-v4.1.0.json`

### Backend syntax check

```bash
npm run check:backend
```

Risultato:

- OK.
- `backend/server.js` valido.
- `serve-frontends.mjs` valido.

### Architecture/security audit

```bash
npm run audit:architecture-security
```

Risultato:

- OK.
- Finding bloccanti: 0.
- Warning architetturali: 10.

Warning principali:

- `backend/server.js` resta monolitico: 38.360 righe.
- `handlePaymentFreeSplit`: 1.347 righe.
- `handlePayTable`: 960 righe.
- `handleIntegrationOrderComp`: 686 righe.
- `handleIntegrationOrderCreate`: 610 righe.
- `handleIntegrationOrderSync`: 548 righe.
- `sanitizeIntegrationOrder`: 535 righe.
- `handleIntegrationStationStateUpsert`: 483 righe.
- `handlePaymentMovementReprint`: 403 righe.

### Architecture/security gate

```bash
npm run gate:architecture-security
```

Risultato:

- OK.
- 173 route.
- 27 moduli.
- Mutazioni pubbliche: 6.
- Warning non bloccanti su monolite e funzioni grandi.

### Route policy architecture test

```bash
node --test backend/tests/route-policy-architecture.test.mjs
```

Risultato:

- OK.
- Test: 4.
- Pass: 4.
- Fail: 0.

### Security architecture test

```bash
node --test backend/tests/security-architecture.test.mjs
```

Risultato:

- OK.
- Test: 6.
- Pass: 6.
- Fail: 0.

## Esito Fase 0

Fase 0 superata per i gate tecnici previsti.

Debiti da portare alla Fase 1:

1. Continuare la riduzione del monolite backend.
2. Estrarre i domini `print-spool` e `fiscal-pos`.
3. Introdurre `event_outbox`.
4. Introdurre `idempotency_keys`.
5. Spostare gli IP operativi residui fuori dal codice sorgente.
6. Modularizzare le route critiche ancora nel registry root: pagamenti,
   fiscale, smart, table lock e room-change.
