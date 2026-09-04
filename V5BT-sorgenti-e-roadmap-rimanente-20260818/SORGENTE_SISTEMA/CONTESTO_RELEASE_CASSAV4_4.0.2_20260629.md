# Contesto release CASSA V4 4.0.2 - 2026-06-29

## Contenuto release

- Sistema cassa V4 sorgente: `G:\CASSAv4-mobilenearend`
- Frontend mobile sorgente: `mobile-frontend`
- Backend / sistema cassa sorgente: `cassa-frontend`, `backend`, `tools`, `ops`
- App Android WebView sorgente: `C:\Users\utente\Desktop\Web2`
- APK incluso nel pacchetto: `apk\app-debug-v4.0.2.apk`

## Stato runtime verificato

- Frontend HTTPS LAN: `https://192.168.0.28:5280/mobile/`
- Backend API: `http://127.0.0.1:5281`
- Backend health verificato: `/api/health`
- Modalita database verificata: MySQL
- Porta frontend: `5280`
- Porta backend: `5281`

## Avvio sistema

Avvio backend corretto:

```powershell
G:\CASSAv4-mobilenearend\logs\autostart\cassav2-backend.cmd
```

Avvio frontend/static HTTPS:

```powershell
cd G:\CASSAv4-mobilenearend
node serve-frontends.mjs
```

Documentazione HTTPS gia inclusa nel sorgente:

- `ISTRUZIONI_RIPRISTINO_HTTPS_20260624.md`
- `HANDOVER_RICOMPILAZIONE_CASSA_V4.md`
- `CONTESTO_COMPLETO_PTT_HTTPS_20260624.md`

## App Android

Sorgente app incluso in:

```text
android-webview-app-source
```

APK incluso in:

```text
apk\app-debug-v4.0.2.apk
```

Per ricompilare su un altro PC:

1. Aprire `android-webview-app-source` con Android Studio.
2. Verificare o rigenerare `local.properties` con il path SDK Android locale.
3. Eseguire:

```powershell
.\gradlew.bat assembleDebug
```

## Ultime correzioni incluse

- Inserimento manuale sconto a caselle `XXXX-XXXX-XXXX`.
- NFC/QR/manuale separano il token buono dal token login tramite `benefitToken`.
- Sconto 100% permanente applicabile anche senza incasso fittizio.
- Percorso Tavoli e percorso Banco allineati per beneficio commerciale al 100%.
- Bundle frontend ricostruito dopo le correzioni.

## Validazioni eseguite

Frontend:

```powershell
cd G:\CASSAv4-mobilenearend\mobile-frontend
npm run test -- tests/static/paymentBenefitInputModes.test.ts tests/paymentBackendPayload.test.ts
npm run typecheck
npm run build
```

Backend:

```powershell
cd G:\CASSAv4-mobilenearend\cassa-frontend
node --test backend/tests/payments-fiscal.e2e.test.mjs
node --check backend/server.js
node --check backend/modules/counter/counter.handlers.js
```

## Note operative

- Non committare certificati o chiavi private.
- Per usare microfono/camera/NFC da WebView mantenere HTTPS LAN funzionante.
- Se il palmare mostra ancora comportamenti vecchi dopo un aggiornamento, ricaricare la WebView o riavviare l'app per scaricare il bundle aggiornato.
