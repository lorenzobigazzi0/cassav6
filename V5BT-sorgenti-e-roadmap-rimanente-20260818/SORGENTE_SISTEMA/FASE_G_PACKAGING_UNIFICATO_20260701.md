# FASE G3 - Packaging unificato

Data: 2026-07-01

## Obiettivo

Rendere `cassa-frontend/scripts/release-package.mjs` il percorso unico per produrre release ed export di lavoro,
evitando che pacchetti futuri includano runtime, database, log, spool di stampa, snapshot o segreti.

## Implementazione

- Aggiunto `cassa-frontend/scripts/package-guardrails.mjs` come contratto condiviso di packaging.
- `release-package.mjs` usa gli stessi guardrail condivisi per generazione e verifica.
- `package-preflight.mjs` e' stato riallineato al layout sorgente reale prodotto da `release-package.mjs`.
- `package-preflight --source` valida il sorgente diretto corrente senza richiedere il vecchio layout `v2/app`.
- `package-preflight --package --root PACKAGE_DIR` valida una cartella generata da `release-package.mjs`.
- Aggiunto script npm `release:verify` per verificare un pacchetto esistente tramite `release-package.mjs --verify`.
- Aggiunto test `cassa-frontend/backend/tests/release-package-guardrails.test.mjs`.
- Il test e' stato inserito in `cassa-frontend/scripts/backend-release-gate.mjs`.

## Guardrail bloccanti

Il pacchetto fallisce se contiene:

- `node_modules`
- `.print-spool`
- `logs`
- `.git`
- `.gradle`
- `test-results`
- `playwright-report`
- DB runtime SQLite/DB
- log o PID
- chiavi/certificati
- snapshot `app-state`
- `tsconfig.tsbuildinfo`
- file backup `.bak`

## Verifiche

- `node --check scripts/package-guardrails.mjs`
- `node --check scripts/package-preflight.mjs`
- `node --check scripts/release-package.mjs`
- `node --check scripts/backend-release-gate.mjs`
- `node --test backend/tests/release-package-guardrails.test.mjs`
- `node scripts/package-preflight.mjs --source`
- `node scripts/release-package.mjs --dry-run`
- `node scripts/release-package.mjs --version v4.1.0-g3-smoke --output /tmp/cassav4-release-smoke --clean --no-zip`
- `node scripts/package-preflight.mjs --package --root /tmp/cassav4-release-smoke/v4.1.0-g3-smoke/sistema-cassa-v4.1.0-g3-smoke-source`
- `node scripts/backend-release-gate.mjs`

Esito: OK.

## Note

La verifica smoke reale ha prodotto una cartella pacchetto temporanea senza finding; i controlli aggiuntivi non
hanno trovato directory o file runtime vietati. La cartella temporanea e' stata usata solo per validare G3.
