# Handover CASSAv4 mobilenearend

Data export: 2026-06-29 09:14 CEST
Workspace sorgente: `/home/sentrapa/Desktop/sistemacassav4/estratto/sistema-v3-source`
Archivio destinazione: USB `/media/sentrapa/HAND/CASSAv4-mobilenearend`

## Scopo

Questo pacchetto contiene il codice sorgente, gli script, le configurazioni, la documentazione e i test necessari per proseguire lo sviluppo e il debug di Sistema Cassa V4 su un altro PC con Codex.

Sono esclusi volutamente `node_modules`, log, cartelle temporanee, cache, database locali e dump runtime. Le dipendenze vanno reinstallate sul nuovo PC tramite i rispettivi `package-lock.json`.

## Stato runtime verificato prima dell'export

- Frontend HTTPS attivo su `https://192.168.1.182:5280/mobile/`.
- Backend locale attivo su `http://127.0.0.1:5281`.
- Backend esposto in LAN su `http://192.168.1.182:5281`.
- Gateway cassa automatica configurato su `http://192.168.1.200:9090`.
- Gateway fiscale configurato su `http://192.168.1.200:8765`.
- Stampanti preconti/comande impostate sul nuovo IP richiesto `192.168.1.195`.
- Database runtime in uso: MySQL locale `127.0.0.1:3306/cassa`.

## Ultime correzioni importanti

- Cambio contanti:
  - corretto il deposito letto come centesimi invece che euro;
  - corretto il riuso di depositi vecchi presi dalla history del gateway;
  - annullamento deposito reso idempotente quando il gateway reale ha gia chiuso o cancellato l'operazione.
- Cassa automatica:
  - timeout backend verso gateway portato a 120 secondi;
  - timeout frontend per operazioni fisiche portato a 130 secondi;
  - QR gia usato ora mostra `QR non valido`;
  - report scarico/deposito corretto con operatore e senza valori non fiscali sporchi.
- Fondo cassa:
  - workflow riprendibile dagli owner e dagli admin secondo lock;
  - conferma scontrino nel borsellino mantiene il workflow occupato fino alla chiusura.
- Pagamenti:
  - sezione pagamenti ridisegnata con metodi Contanti e Carta;
  - POS letti da configurazione DB/app-state invece di mock frontend;
  - aggiunte funzioni cassa automatica: genera fondo cassa e scambio contanti.
- Radio/mobile:
  - canali radio e preferenze utente persistite;
  - fix precedenti su pill TX/RX, bot/eot locali, echo e rumore statico.
- Frontend:
  - filtri home/tavoli riallineati;
  - bottom bar resa cliccabile;
  - QR camera e permessi corretti;
  - build mobile prod verificata.

## File chiave modificati di recente

- `cassa-frontend/backend/modules/automatic-cash/automatic-cash.gateway.js`
- `cassa-frontend/backend/modules/automatic-cash/automatic-cash.handlers.js`
- `cassa-frontend/backend/modules/automatic-cash/automatic-cash.domain.js`
- `cassa-frontend/backend/tests/automatic-cash.test.mjs`
- `cassa-frontend/backend/server.js`
- `tools/start-v3-backend-mysql-local.sh`
- `mobile-frontend/src/api/automaticCash.ts`
- `mobile-frontend/src/api/cashExchange.ts`
- `mobile-frontend/src/utils/automaticCashErrors.ts`
- `mobile-frontend/src/pages/payments/AutomaticSettlementWizard.tsx`
- `mobile-frontend/src/pages/payments/CashExchangeWizard.tsx`
- `mobile-frontend/src/pages/payments/PaymentSettlementSection.tsx`

## Comandi verificati

Dal root progetto:

```bash
PATH=/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin:$PATH node --check cassa-frontend/backend/modules/automatic-cash/automatic-cash.gateway.js
PATH=/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin:$PATH node --check cassa-frontend/backend/server.js
PATH=/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin:$PATH node --test cassa-frontend/backend/tests/automatic-cash.test.mjs
bash tools/start-v3-backend-mysql-local.sh
curl -sk http://127.0.0.1:5281/api/health
```

Dal frontend mobile:

```bash
cd mobile-frontend
npm install
npm run build
```

Esito ultimo giro:

- `automatic-cash.test.mjs`: 17 test passati su 17.
- `mobile-frontend npm run build`: OK.
- Backend riavviato con health OK.
- Processo backend vivo con `AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS=120000`.
- Gateway reale `192.168.1.200:9090/api/state`: raggiungibile, mode `REAL`, `activeOperation: null`.

## Avvio su altro PC

1. Estrarre lo zip preservando la cartella root `sistema-v3-source/`.
2. Installare Node >= 20.19, preferibilmente 22.x o 26.x.
3. Installare le dipendenze nei frontend/backend che si vogliono avviare:

```bash
cd mobile-frontend && npm install
cd ../cassa-frontend && npm install
cd ../battery-dashboard && npm install
cd ../postazione && npm install
```

4. Preparare MySQL locale oppure adattare lo script `tools/start-v3-backend-mysql-local.sh`.
5. Aggiornare gli IP nello script se la nuova rete cambia:
   - `POS_FISCAL_API_BASE_URL`
   - `AUTOMATIC_CASH_GATEWAY_BASE_URL`
   - stampanti/preconti/comande nel DB/configurazione
6. Avviare backend:

```bash
bash tools/start-v3-backend-mysql-local.sh
```

7. Avviare o servire i frontend con HTTPS. In questa macchina veniva usato `serve-frontends.mjs` su porta `5280`.

## Note di attenzione

- Il DB live MySQL non e incluso nello zip. Se serve replicare esattamente il locale attuale, fare un dump MySQL separato prima di spostarsi.
- `cassa-frontend/backend/app-state.json` e `app-state-split.sqlite` sono esclusi per evitare di portare stato runtime vecchio o dati operativi.
- I test sono inclusi, compresi quelli sviluppati su cassa automatica, pagamenti, radio, concorrenza, print queue e stato ordini.
- `git` non era disponibile nella shell al momento del packaging, quindi questo handover elenca manualmente i punti di contesto piu importanti.
- Prima di test reali con cassa automatica verificare sempre che il gateway su `192.168.1.200:9090` sia quello corretto e non il gateway fiscale.

