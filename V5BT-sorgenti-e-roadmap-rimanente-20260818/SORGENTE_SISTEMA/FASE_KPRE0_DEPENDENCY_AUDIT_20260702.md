# FASE K-PRE.0 - Dependency audit handler pagamenti/fiscale

Data: 2026-07-02

## Obiettivo

Eseguire l'audit preliminare richiesto da `ROADMAP_KPRE_CASSAV4.md` prima di spostare codice da `backend/server.js`, identificando le dipendenze top-level dei quattro handler target della futura estrazione K-PRE.1.

## Artefatti

- Script: `cassa-frontend/scripts/dependency-audit.mjs`.
- Output JSON: `cassa-frontend/docs/architecture/payments-dependency-audit-20260702.json`.

## Handler analizzati

| Handler | Righe | Dimensione | Dipendenze factory |
|---|---:|---:|---:|
| `handleFiscalCommand` | 37666-37768 | 103 righe | 13 |
| `handlePaymentMovementReprint` | 39051-39224 | 174 righe | 24 |
| `handlePayTable` | 30499-31500 | 1002 righe | 66 |
| `handlePaymentFreeSplit` | 32037-33444 | 1408 righe | 69 |

## Dipendenze condivise principali

Tutti e quattro gli handler condividono:

- `HttpError`
- `sendJson`
- `nowIso`
- `appendAuditEvent`
- `readDb`
- `writePaymentDb`
- `buildAuditActor`
- `validateSessionContext`
- `readJsonBody`

Tre handler condividono inoltre:

- `randomUUID`
- `ensurePaymentTrackingArrays`
- `executeFiscalProvider`
- `isPosDemoModeEnabled`

I due handler grandi (`payments/table` e `payments/free-split`) condividono gran parte del nucleo pagamenti: idempotenza, fiscalita', autorizzazione carta, calcoli importi, tracking container/parts/transactions, lock tavolo e publish realtime. Il dettaglio completo e' nel JSON.

## Note di verifica

- Nessun parser esterno (`acorn`, `@babel/parser`, `espree`, `typescript`) era risolvibile dal workspace, quindi lo script usa il parser minimale previsto dalla roadmap.
- Lo script maschera commenti/stringhe/template, individua il range funzione, raccoglie parametri, binding locali e dichiarazioni top-level, poi produce le dipendenze candidate da passare alle future factory K-PRE.1.
- Gli `unknownExternalIdentifiers` nel JSON sono mantenuti come rumore di revisione: per lo piu' chiavi oggetto, literal/template e variabili locali non utili come dipendenze factory. Le dipendenze top-level vere risultano nella lista `dependencies`.

## Test eseguiti

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/dependency-audit.mjs`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node cassa-frontend/scripts/dependency-audit.mjs --source backend/server.js --out docs/architecture/payments-dependency-audit-20260702.json`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

K-PRE.0 completato. Come richiesto dalla roadmap, qui si applica lo **STOP/REVIEW leggero**: prima di K-PRE.1.1 non e' stato spostato nessun handler. Il prossimo passo, dopo conferma, e' K-PRE.1.1: estrarre `handleFiscalCommand` in `modules/fiscal-pos/` usando le 13 dipendenze rilevate come parametri della factory.
