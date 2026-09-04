# Sistema Cassa V4 - handover v4.6

Questo e' il metadato autorevole del pacchetto. I vecchi README/MANIFEST Step 2 e Step 3 sono esclusi per evitare ambiguita' sul contenuto certificato.

## Correzione P0 packaging

Il pacchetto include e verifica tutti i moduli runtime in `cassa-frontend/backend/modules/reports/`. La preflight fallisce se anche uno dei cinque file obbligatori manca.

## Identita'

- Label: `v4.6`
- Root archivio: `sistema-cassa-v4.6-source/`
- Snapshot sorgente: `sistema-cassa-p4.3-realtime-notifications-fix-20260714-source`
- Commit Git: non disponibile nella sorgente ricevuta
- Content tree SHA256: `b65eebeb7e9c90414b86909214512d2e55c86f3bd6ca9839be755147f6f12e4c`
- Dettagli macchina: `BUILD_INFO.json`
- Elenco file: `MANIFEST.txt`
- Checksum di ogni file: `SHA256SUMS`

## Installazione e verifica isolata

Dalla root estratta:

```bash
cd cassa-frontend
npm ci --no-audit --no-fund
npm run check:backend
node scripts/package-preflight.mjs --package --root ..
npm run smoke:package-runtime
```

Lo smoke avvia il vero entry point backend, usa un DB JSON temporaneo, chiama `/api/health` e tre API pubbliche, quindi termina il processo. Stampa, fiscale, MQTT, Redis e cassa automatica reali restano disabilitati.

## Stato della roadmap

La roadmap e le evidenze disponibili sono incluse nel pacchetto. Il sorgente contiene anche l'harness P5; il packaging non dichiara da solo completata alcuna fase e gli esiti devono essere letti nei report allegati.
