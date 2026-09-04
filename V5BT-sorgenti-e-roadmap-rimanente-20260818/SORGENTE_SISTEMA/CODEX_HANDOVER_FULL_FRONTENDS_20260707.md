# CASSAv4 handover completo con frontend - 2026-07-07

## Scopo

Questo pacchetto serve a continuare il lavoro da un altro PC con un altro
Codex includendo anche i frontend che non erano presenti nello zip precedente
basato solo su `cassa-frontend`.

## Root pacchettizzata

```text
D:\cassav2\CASSAV4_STEP3_COMMAND_INBOX_FOUNDATION_20260706
```

## Frontend inclusi

Sorgenti disponibili:

```text
mobile-frontend/
postazione/
battery-dashboard/
```

Frontend presenti nella tree corrente solo come build/dist:

```text
settings-frontend/
reservation-frontend/
monitor-frontend/
```

Questi ultimi vengono inclusi comunque, perche' nella copia locale attuale non
risulta presente una cartella `src` sotto quelle directory.

## Backend e roadmap inclusi

```text
backend/
cassa-frontend/
docs/
ops/
tools/
serve-frontends.mjs
FASE_*.md
HANDOVER_*.md
WORKSPACE_ATTIVA.md
STATO_AVANZAMENTO_20260702.md
```

Dentro `cassa-frontend/` e' incluso anche:

```text
cassa-frontend/CODEX_HANDOVER_20260707.md
cassa-frontend/docs/mqtt-bridge-step14.md
cassa-frontend/reports/STEP_14A...STEP_14I...
```

## Esclusi

Non inclusi nello zip:

```text
node_modules/
logs/
backups/
certs/
screenshots/
.git/
*.pem
*.key
*.crt
*.pfx
*.p12
*.log
tsconfig.tsbuildinfo
```

Le dipendenze vanno reinstallate sull'altro PC con `npm install` nelle cartelle
che hanno `package.json`.

## Comandi utili sull'altro PC

Backend/roadmap principale:

```bash
cd cassa-frontend
npm install
npm run test:phase14i
npm run check:backend
```

Mobile frontend:

```bash
cd mobile-frontend
npm install
npm run build
```

Postazione:

```bash
cd postazione
npm install
npm run build
```

Battery dashboard:

```bash
cd battery-dashboard
npm install
npm run build
```

## Nota operativa

Il checkout locale non risulta un repository git valido. Per verificare il
pacchetto usare:

- manifest interno `ARCHIVE_CONTENTS_MANIFEST.txt`;
- presenza dei file sorgente;
- `npm install`;
- test npm indicati sopra.
