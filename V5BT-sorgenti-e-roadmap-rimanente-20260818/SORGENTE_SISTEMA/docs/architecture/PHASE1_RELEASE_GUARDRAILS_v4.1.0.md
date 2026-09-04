# Phase 1 Release Guardrails v4.1.0

Data: 2026-06-30

Obiettivo: rendere ripetibile la produzione di un pacchetto sorgente pulito,
verificabile e adatto a passaggio su altro PC o nuova release, senza includere
runtime, database, log, spool o segreti.

## Artefatti Introdotti

- `docs/architecture/ADR-0001-modular-monolith.md`
- `cassa-frontend/scripts/release-package.mjs`
- script npm:
  - `npm run release:package`
  - `npm run release:package:dry-run`

## Cosa Include Il Pacchetto

- sorgenti backend e frontend;
- dist statici necessari all'avvio attuale;
- documentazione architetturale;
- test e script di verifica;
- sorgente Android/APK se presenti nella root sorgente.

## Cosa Esclude Il Pacchetto

- `node_modules`;
- `.git`;
- `.gradle`;
- `.print-spool`;
- `logs`;
- `test-results`;
- `playwright-report`;
- `screenshots`;
- `mobile-frontend/certs`;
- file `*.log`, `*.pid`;
- database/runtime `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.db`;
- certificati/chiavi `*.pem`, `*.key`, `*.p12`, `*.crt`;
- snapshot runtime `app-state.before-*.json`, `app-state.partial-*.json`,
  `app-state.json`, `mock-db.json`;
- `tsconfig.tsbuildinfo`.

## Comandi Standard

Da `cassa-frontend`:

```bash
npm run release:package:dry-run
npm run release:package -- --version v4.1.0 --clean
```

Output default:

```text
/home/sentrapa/Desktop/sistemacassav4/release-packages/v4.1.0/
```

Dentro l'output:

```text
sistema-cassa-v4.1.0-source/
sistema-cassa-v4.1.0-source.zip
sistema-cassa-v4.1.0-source.zip.sha256
```

Verifica pacchetto esistente:

```bash
node scripts/release-package.mjs --verify /percorso/al/pacchetto/sistema-cassa-v4.1.0-source
```

## Gate Minimi Prima Del Packaging

Da `cassa-frontend`:

```bash
npm run check:backend
npm run audit:architecture-security
npm run gate:architecture-security
node --test backend/tests/route-policy-architecture.test.mjs
node --test backend/tests/security-architecture.test.mjs
```

## Gate Minimi Dopo Il Packaging

```bash
unzip -t sistema-cassa-v4.1.0-source.zip
sha256sum -c sistema-cassa-v4.1.0-source.zip.sha256
node scripts/release-package.mjs --verify sistema-cassa-v4.1.0-source
```

## Criteri Di Fallimento

Il pacchetto deve fallire se contiene:

- DB runtime;
- log o PID;
- spool di stampa;
- chiavi/certificati;
- `node_modules`;
- snapshot `app-state` runtime;
- file obbligatori mancanti.

## Stato Step 1

Step 1 completato quando:

- ADR-0001 presente;
- script packaging presente e richiamabile da npm;
- dry-run passa;
- pacchetto reale generato almeno una volta;
- verifica package clean passa;
- zip e checksum sono presenti.
