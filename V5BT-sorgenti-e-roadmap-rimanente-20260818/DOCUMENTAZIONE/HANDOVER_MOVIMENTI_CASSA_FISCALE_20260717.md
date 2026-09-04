# Handover CASSAv4 - movimenti cassa e azioni fiscali

Data: 2026-07-17

## Workspace autorevole

```text
D:\cassav2\CASSAV4_V4.6_CURRENT
```

Sorgente del sistema:

```text
D:\cassav2\CASSAV4_V4.6_CURRENT\sistema-cassa-v4.6-source
```

## Funzioni completate

- La pressione prolungata su `STATISTICHE` apre tre viste:
  `PAGAMENTI`, `MOVIMENTI` e `FONDI CASSA`.
- `MOVIMENTI` raccoglie caricamenti, prelievi e cambi cassa con stato,
  importo, operatore, postazione e giustificazione.
- Nel menu Pagamenti sono disponibili `CARICAMENTO` e `PRELIEVO`.
- Il backend conserva i movimenti in modo durevole, applica idempotenza,
  transizioni esplicite e selezione dei tagli nel rispetto della riserva.
- I badge Contanti e Carta hanno icone, colori distinti e gradienti nella
  stessa direzione, con varianti light e dark.
- `EMETTI FISCALE` usa l'asset
  `src/assets/icons/fiscal/agenzia-entrate.png`.
- Dopo una pressione lunga, la stampa avanzata mantiene sempre la label
  visibile `STAMPA`: il pulsante resta giallo durante l'invio e torna verde
  soltanto al completamento.
- La sezione di configurazione cassa automatica e nuovamente montata nelle
  impostazioni per gli utenti autorizzati.

## API aggiunte

```text
GET  /api/automatic-cash/cash-movements
GET  /api/automatic-cash/cash-movements/active
POST /api/automatic-cash/cash-movements/start
POST /api/automatic-cash/cash-movements/:movementId/complete
POST /api/automatic-cash/cash-movements/:movementId/cancel
```

Gli handler sono in:

```text
cassa-frontend/backend/modules/automatic-cash/cash-movement.domain.js
cassa-frontend/backend/modules/automatic-cash/cash-movement.handlers.js
```

## Webapp

Il sorgente canonico e in `sistema-cassa-v4.6-source/mobile-frontend`.
Il bundle pronto da servire e in `mobile-frontend/dist` e contiene anche
l'icona Agenzia Entrate.

Avvio dell'intero stack MySQL + HTTPS:

```powershell
cd D:\cassav2\CASSAV4_V4.6_CURRENT\sistema-cassa-v4.6-source
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\start-cassav2-current.ps1
```

URL LAN:

```text
https://192.168.0.28:5280/mobile/
https://192.168.0.28:5280/cassa/
https://192.168.0.28:5280/postazione/
```

Il backend usa `BACKEND_DB_MODE=mysql` e il database
`127.0.0.1:3306/cassa`.

## Applicazioni Android

Palmare:

```text
android\Palmare\Palmare-1.0.16-debug.apk
versionCode 17
versionName 1.0.16
SHA-256 4815410159F468EFCF5649CA1DEC5C9E6F6F5342756D5DA1EDB4D88CC65A706F
```

Postazione:

```text
android\Postazione\Postazione-2.0.14-debug.apk
versionCode 16
versionName 2.0.14
SHA-256 D44C2F28FA7ED888A6BACA04F10A6ABCF1AF1487E9CC5D8496AB72CCC637739F
```

La copia embedded del Palmare conserva gli owner offline Android e risulta
sincronizzata con i file frontend modificati.

## Validazione eseguita

```text
Frontend mirato: 34/34 test passati
Backend automatic cash: 33/33 test passati
Backend split guard incluso: passato
TypeScript mobile: passato
Build Vite mobile canonica: passata
Build Vite mobile embedded Palmare: passata
Build cassa frontend: passata
Android Palmare unit test + lint + assembleDebug: passati
HTTPS webapp: HTTP 200 su https://192.168.0.28:5280/mobile/
Backend health: ok, database mode mysql
```

## Nota operativa

Il gateway fiscale esterno non era raggiungibile durante l'ultima verifica
locale. Questo non ha impedito build e test, ma le emissioni fiscali reali
richiedono il relativo servizio attivo.
