# Istruzioni ripristino Cassa V3 HTTPS LAN

Data pacchetto: 2026-06-24

## Obiettivo

Ripristinare il sistema Cassa V3 e aprire la webapp mobile da tablet o telefono in LAN con:

```txt
https://192.168.0.28:5280/mobile/
```

La modalita HTTPS e necessaria per usare il microfono WebRTC/Web Audio della Radio PTT.

## Contenuto del pacchetto

- `sistema-v3-source/`: sorgente completo del sistema V3.
- `android-webview-app-source/`: sorgente dell'app Android/WebView.
- `apk/app-debug.apk`: APK debug gia pronto.
- `docs/`: istruzioni, contesto e file operativo HTTPS originale.

## Prerequisiti server

- Windows.
- Node.js compatibile con i progetti Vite/Node.
- MySQL in ascolto su `127.0.0.1:3306`.
- Database locale `cassa`.
- Utente MySQL applicativo gia configurato come previsto dallo script di avvio.
- IP LAN del server impostato o raggiungibile come `192.168.0.28`.
- Firewall Windows aperto almeno per:
  - TCP `5280` frontend HTTPS/proxy API/WebSocket.
  - TCP `5281` backend interno.
  - TCP `8765` battery service.
  - TCP `3306` MySQL solo locale, se possibile.

## Ripristino sorgente V3

1. Copiare `sistema-v3-source` nella posizione operativa desiderata, per esempio:

```powershell
D:\cassav2\work-patch7\v3
```

2. Entrare nei progetti principali e installare dipendenze se mancano:

```powershell
cd D:\cassav2\work-patch7\v3\mobile-frontend
npm install

cd D:\cassav2\work-patch7\v3\cassa-frontend
npm install

cd D:\cassav2\work-patch7\v3\battery-dashboard
npm install
```

3. Ricompilare il mobile se serve:

```powershell
cd D:\cassav2\work-patch7\v3\mobile-frontend
npm run build
```

## Certificati HTTPS LAN

I certificati e le chiavi private non sono inclusi nel pacchetto. Vanno rigenerati sul server.

1. Installare `mkcert` se non presente.

Windows con Chocolatey:

```powershell
choco install mkcert
```

Windows con Scoop:

```powershell
scoop install mkcert
```

2. Generare certificato e chiave per IP LAN:

```powershell
cd D:\cassav2\work-patch7\v3\mobile-frontend
npm run cert:lan
```

Questo genera:

```txt
D:\cassav2\work-patch7\v3\mobile-frontend\certs\192.168.0.28.pem
D:\cassav2\work-patch7\v3\mobile-frontend\certs\192.168.0.28-key.pem
```

3. Non copiare e non condividere mai:

```txt
rootCA-key.pem
```

## Installazione CA sui client

Per evitare errori certificato su tablet/telefono, installare sui client solo la CA pubblica di mkcert.

1. Sul server trovare il percorso CA:

```powershell
mkcert -CAROOT
```

2. Copiare sul client solo:

```txt
rootCA.pem
```

3. Android:

- Aprire Impostazioni.
- Cercare "Certificati" o "Installa certificato".
- Installare `rootCA.pem` come certificato CA.
- Se richiesto, impostare un blocco schermo.
- Riavviare browser/WebView o riavviare il device.

4. Windows client:

- Aprire `certmgr.msc`.
- Importare `rootCA.pem` in "Autorita di certificazione radice attendibili".

## Avvio sistema completo

Usare sempre lo script ufficiale:

```powershell
cd D:\cassav2\work-patch7\v3
.\AVVIA_CASSAV2_ATTUALE.cmd
```

Lo script avvia:

- Battery service su `0.0.0.0:8765`.
- Backend su `0.0.0.0:5281`.
- Frontend HTTPS/proxy su `0.0.0.0:5280`.
- Mobile Vite dev su `0.0.0.0:5173`, salvo opzione `-SkipMobileDev` nello script PowerShell.

Lo script usa MySQL puro tramite le variabili definite in `tools/start-cassav2-current.ps1`.

## URL operativi

Mobile:

```txt
https://192.168.0.28:5280/mobile/
```

Test microfono:

```txt
https://192.168.0.28:5280/mic-test.html
```

Health backend via proxy HTTPS:

```txt
https://192.168.0.28:5280/api/health
```

Backend interno:

```txt
http://127.0.0.1:5281/api/health
```

Battery:

```txt
http://127.0.0.1:8765/battery
```

## Installazione APK Android

APK incluso:

```txt
apk\app-debug.apk
```

Installazione via ADB:

```powershell
adb install -r apk\app-debug.apk
```

Al primo avvio inserire:

```txt
https://192.168.0.28:5280/mobile/
```

Se l'app aveva salvato un URL vecchio:

- Impostazioni Android.
- App.
- Amalia Advanced.
- Memoria.
- Cancella dati.
- Riaprire l'app e inserire l'URL HTTPS corretto.

## Verifiche rapide

Da server:

```powershell
curl.exe -k https://192.168.0.28:5280/mobile/
curl.exe -k https://192.168.0.28:5280/api/health
curl.exe http://127.0.0.1:5281/api/health
curl.exe http://127.0.0.1:8765/battery
```

Da Android:

1. Aprire `https://192.168.0.28:5280/mobile/`.
2. Aprire `https://192.168.0.28:5280/mic-test.html`.
3. Verificare permesso microfono.
4. Verificare Radio/Echo Test.
5. Verificare PTT bottom bar.

## Note importanti

- Non avviare il backend a mano senza le variabili MySQL: il login puo fallire per DB/env incompleto.
- Non usare `http://192.168.0.28:5280` per la radio: il microfono richiede HTTPS.
- Non includere certificati generati, chiavi private o root CA privata nei backup.
- Se `https://192.168.0.28:5280/mobile` senza slash crea problemi, usare sempre `/mobile/`.
- Lo script `serve-frontends.mjs` gestisce anche il redirect da `/mobile` a `/mobile/`.
