# Contesto e Handover - CASSA v3

Aggiornato: 2026-06-24 04:04 CEST

## Scope ultimo intervento

Il focus operativo richiesto e' solo su:

- `mobile-frontend`
- `postazione`

Il tuning backend/DB provato durante il giro e' stato fermato e riportato al punto precedente prima del packaging. La produzione live non e' stata riavviata per quel tuning.

## Modifiche incluse

- Ricompilato `mobile-frontend/dist`.
- Ricompilato `postazione/dist`.
- Sistemato il gate statico del mobile riducendo solo righe vuote/spaziature superflue nei componenti:
  - `mobile-frontend/src/pages/home/tables/components/TablePaymentWizard.tsx`
  - `mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx`
  - `mobile-frontend/src/pages/home/tables/components/TableServiceRecoveryDialog.tsx`
- Nessun cambio intenzionale a design, layout o testi utente in questi tre componenti.

## Verifiche eseguite

Comandi eseguiti con Node locale:

- `node --test frontend-tests/mobile-frontendv2-static.test.mjs frontend-tests/mobile-bridges.test.mjs frontend-tests/postazione-bridges.test.mjs frontend-tests/bridge-hardening.test.mjs`
  - Esito: 63/63 pass.
- `mobile-frontend`: typecheck TypeScript.
  - Esito: pass.
- `mobile-frontend`: `vitest run tests/static`.
  - Esito: 30 file, 88 test pass.
- `mobile-frontend`: `vitest run`.
  - Esito: 59 file, 202 test pass.
- `mobile-frontend`: `vite build`.
  - Esito: pass.
- `postazione`: `vite build`.
  - Esito: pass.
- Playwright reale `cassa-frontend/e2e/mobile-cassa-postazione.spec.mjs`.
  - Esito: 3/3 pass.

## Note ambiente build

Su questa USB il filesystem non esegue correttamente alcuni binari senza estensione dentro `node_modules` (`esbuild`), quindi per le build Vite e' stata usata una copia temporanea:

```bash
cp postazione/node_modules/@esbuild/linux-x64/bin/esbuild /tmp/esbuild-postazione
chmod +x /tmp/esbuild-postazione
ESBUILD_BINARY_PATH=/tmp/esbuild-postazione node node_modules/vite/bin/vite.js build
```

Questo non cambia il sorgente e serve solo per compilare da chiavetta.

## Produzione live verificata

Verifiche HTTP finali:

- `http://192.168.1.182:5280/mobile/` -> 200
- `http://192.168.1.182:5280/postazione/` -> 200

Processi rilevati:

- frontend/static server: porta `5280`
- backend: porta `5281`

## File zip aggiornato

Lo zip aggiornato su chiavetta e':

- `/media/sentrapa/HAND/cassav2-v3-patch7-complete-source.zip`

Backup dello zip precedente:

- `/media/sentrapa/HAND/backups/cassav2-v3-patch7-complete-source-before-20260624-0404.zip`

## Ripresa consigliata

Per continuare:

1. Se il problema e' visuale o prestazionale lato operatore, ripartire da `mobile-frontend` e `postazione`.
2. Non riaprire il tuning backend/DB salvo richiesta esplicita.
3. Dopo ogni modifica a mobile/postazione, rieseguire almeno:
   - test bridge mobile/postazione in `cassa-frontend/frontend-tests`
   - `mobile-frontend` typecheck + vitest
   - build `mobile-frontend`
   - build `postazione`
   - smoke Playwright `mobile-cassa-postazione.spec.mjs`

