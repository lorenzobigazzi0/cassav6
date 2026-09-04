# Handover ricompilazione Cassa V4

Creato: 2026-06-26 17:36:41
Sorgente originale: G:\2026-06-26\sistemacassav4\estratto\sistema-v3-source
Pacchetto: G:\cassaV4_ambiente_src_HAND_20260626-173638.zip

## Ambiente rilevato
- Windows PowerShell
- Node.js: v22.16.0
- npm: 11.8.0

## Contenuto
- Sorgente completo del sistema V3/Cassa V4 aggiornato.
- Package manifest e lockfile presenti nei sottoprogetti.
- File di configurazione e script inclusi.
- Copia reverse recente inclusa in mobile-frontend/_reverse_20260626-172744 se presente.

## Esclusioni intenzionali
- 
ode_modules: reinstallare con 
pm install.
- dist: ricreare con build.
- logs: runtime locale.
- certs, *.pem, *.key, ootCA-key.pem: certificati e chiavi private locali non devono essere trasferiti come sorgente.
- *.tsbuildinfo: cache TypeScript.

## Comandi principali
Da mobile-frontend:
`powershell
npm install
npm run typecheck
npm run build
`

Per HTTPS LAN su Vite, rigenerare i certificati sul nuovo PC:
`powershell
cd mobile-frontend
npm run cert:lan
npm run dev:lan:https
`

Da cassa-frontend:
`powershell
npm install
npm test -- --runInBand
`

Se i test backend usano Node test runner:
`powershell
node --test backend/tests/automatic-cash.test.mjs
`

## Note operative
- Non copiare certificati HTTPS o chiavi private da questa macchina: rigenerarli sul PC nuovo.
- L'URL LAN previsto resta quello configurato nel progetto, da adattare se cambia IP del server.
- Le ultime modifiche includono: pagina Pagamenti riorganizzata, gateway cambio/fondo cassa automatico abilitato in base all'endpoint in ascolto, filtro legenda tavoli con passaggio temporaneo da esclusione a solo uno.
