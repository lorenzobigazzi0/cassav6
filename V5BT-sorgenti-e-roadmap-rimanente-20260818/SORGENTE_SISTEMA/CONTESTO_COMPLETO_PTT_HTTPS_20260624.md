# Contesto completo Cassa V3 + App Android + Radio PTT

Data contesto: 2026-06-24

## Stato operativo

Il sistema corrente e il sistema Cassa V3 in:

```txt
D:\cassav2\work-patch7\v3
```

L'app Android/WebView corrente e in:

```txt
C:\Users\utente\Desktop\Web2
```

APK corrente:

```txt
C:\Users\utente\Desktop\Web2\app\build\outputs\apk\debug\app-debug.apk
```

URL finale previsto in LAN:

```txt
https://192.168.0.28:5280/mobile/
```

## Architettura principale

### Sistema V3

- `cassa-frontend/`: backend Node e frontend cassa.
- `mobile-frontend/`: frontend mobile React/Vite.
- `settings-frontend/`: impostazioni.
- `postazione/`: frontend postazione.
- `monitor-frontend/`: monitor.
- `reservation-frontend/`: prenotazioni.
- `battery-dashboard/`: servizio batteria per i device.
- `serve-frontends.mjs`: server statico/proxy HTTPS su LAN per servire le app compilate e proxy API/WebSocket.
- `tools/start-cassav2-current.ps1`: avvio ufficiale Windows.
- `AVVIA_CASSAV2_ATTUALE.cmd`: wrapper di avvio.

### Avvio ufficiale

Avviare sempre da:

```powershell
D:\cassav2\work-patch7\v3\AVVIA_CASSAV2_ATTUALE.cmd
```

Lo script:

- libera le porte `5173`, `5280`, `5281`, `8765`;
- verifica o avvia MySQL locale;
- avvia battery service;
- avvia backend Node con DB MySQL;
- avvia frontend HTTPS LAN;
- opzionalmente avvia anche Vite dev mobile su `5173`.

### Porte

- `5280`: frontend HTTPS LAN e proxy API/WebSocket.
- `5281`: backend interno.
- `8765`: battery service.
- `5173`: Vite dev mobile.
- `3306`: MySQL locale.

## Database

Il backend deve girare in MySQL, non JSON.

La configurazione runtime e nello script:

```txt
tools\start-cassav2-current.ps1
```

Variabili importanti:

- `BACKEND_DB_MODE=mysql`
- `BACKEND_MYSQL_HOST=127.0.0.1`
- `BACKEND_MYSQL_PORT=3306`
- `BACKEND_MYSQL_DATABASE=cassa`
- split attivi per sessioni, audit e domini app-state.

Nota: se il backend viene avviato manualmente senza queste variabili, il login e le API possono fallire o lavorare su uno stato diverso.

## HTTPS LAN

Il server HTTPS operativo e `serve-frontends.mjs`.

Impostazioni principali:

- host `0.0.0.0`;
- porta `5280`;
- IP LAN `192.168.0.28`;
- certificato atteso in `mobile-frontend\certs\192.168.0.28.pem`;
- chiave attesa in `mobile-frontend\certs\192.168.0.28-key.pem`.

I certificati vanno generati con:

```powershell
cd D:\cassav2\work-patch7\v3\mobile-frontend
npm run cert:lan
```

Il file operativo originale per HTTPS LAN e stato trovato in:

```txt
F:\v3\codex_https_lan_vite_5280.md
```

ed e incluso nel pacchetto.

## Frontend mobile

Cartella:

```txt
mobile-frontend
```

Tecnologie:

- React 18.
- Vite.
- TypeScript.
- Vitest.
- React Router.

Script utili:

```powershell
npm run typecheck
npm test
npm run build
npm run cert:lan
npm run dev:lan:https
```

La base mobile e:

```txt
/mobile/
```

Il server/proxy gestisce anche il redirect da:

```txt
/mobile
```

a:

```txt
/mobile/
```

## Radio PTT

La Radio PTT e composta da:

### Backend

- Hub WebSocket radio sotto `/api/radio/ws`.
- Configurazione canali radio servita da API mobile radio.
- Lock canale occupato.
- Echo test.
- Streaming audio live con frame binari.

### Frontend mobile

File principali:

- `mobile-frontend/src/radio/RadioProvider.tsx`
- `mobile-frontend/src/radio/radioWsClient.ts`
- `mobile-frontend/src/radio/radioAudioEngine.ts`
- `mobile-frontend/src/radio/radioPlaybackEngine.ts`
- `mobile-frontend/src/radio/radioProtocol.ts`
- `mobile-frontend/src/pages/RadioPage.tsx`
- `mobile-frontend/src/pages/home/components/BottomBar.tsx`
- `mobile-frontend/src/pages/home/components/SystemRow.tsx`
- `mobile-frontend/src/pages/home/components/TopbarRight.tsx`

Comportamento richiesto/implementato:

- bottom bar usata come PTT;
- slot radio configurabili in pagina Radio;
- Echo Test;
- apertura canali via WebSocket;
- spettro audio durante trasmissione;
- tono BOT/EOT locale;
- pill top bar in ricezione radio;
- ring avatar riservato allo stato sistema/backend, non allo stato radio.

Modifica recente:

- Ogni apertura della pagina Radio richiama `refreshConfig()` dal `RadioProvider`, cosi eventuali canali aggiunti/rimossi nelle impostazioni vengono riletti subito e la sottoscrizione WebSocket viene riallineata.

Test recente:

```powershell
cd D:\cassav2\work-patch7\v3\mobile-frontend
npm test -- tests/radioPage.test.tsx
npm run typecheck
npm run build
```

Risultato: passati.

## App Android/WebView

Cartella:

```txt
C:\Users\utente\Desktop\Web2
```

Package:

```txt
com.sentrapa.webkiosk.advanced
```

Activity:

```txt
com.sentrapa.webkiosk.MainActivity
```

Permessi principali:

- Internet.
- Record audio.
- Modify audio settings.
- Camera.
- Wake lock.
- Foreground service.
- Notifications.

Caratteristiche rilevanti:

- salva l'URL al primo avvio;
- per cambiare URL si puo cancellare dati app;
- gestisce richieste WebView `PermissionRequest` per audio/video;
- contiene supporto per HTTPS locale tramite `LocalHttpsTrust.kt`;
- invia batteria al servizio su `8765`;
- mantiene comportamento kiosk/fullscreen.

APK incluso:

```txt
apk\app-debug.apk
```

## Login e verifica

Login operativo noto, se il DB locale contiene ancora gli utenti correnti:

```txt
admin / 1234
```

Verifiche consigliate dopo ripristino:

1. `https://192.168.0.28:5280/mobile/` apre il login o la home.
2. Login funziona.
3. `https://192.168.0.28:5280/mic-test.html` accede al microfono.
4. Pagina Radio mostra canali aggiornati.
5. Echo Test registra e riproduce.
6. PTT bottom bar trasmette.
7. Un secondo device riceve audio e pill radio.
8. Ring avatar resta legato a backend/DB, non alla radio.
9. Battery torna visibile dopo riavvio device.

## Problemi noti e cause frequenti

### Login non funziona

Cause probabili:

- backend avviato manualmente senza env MySQL;
- MySQL non attivo;
- DB `cassa` non raggiungibile;
- URL `/mobile` senza slash su vecchie build.

Rimedio:

```powershell
cd D:\cassav2\work-patch7\v3
.\AVVIA_CASSAV2_ATTUALE.cmd
```

### `ERR_SSL_PROTOCOL_ERROR`

Cause probabili:

- porta `5280` servita in HTTP mentre il client apre HTTPS;
- certificati mancanti;
- server non riavviato dopo generazione certificati;
- vecchio processo ancora in ascolto.

Rimedio:

```powershell
cd D:\cassav2\work-patch7\v3\mobile-frontend
npm run cert:lan
cd ..
.\AVVIA_CASSAV2_ATTUALE.cmd
```

### Microfono non disponibile

Cause probabili:

- pagina aperta in HTTP;
- CA non installata sul device;
- permesso microfono negato in Android;
- URL salvato nell'app WebView non aggiornato;
- WebView vecchia o cache dati app sporca.

Rimedio:

- installare `rootCA.pem`;
- cancellare dati app;
- riaprire con `https://192.168.0.28:5280/mobile/`;
- verificare `mic-test.html`.

### PTT trasmette ma non si sente

Separare i controlli:

- il device mittente deve inviare frame WebSocket binari;
- il ricevente deve essere iscritto allo stesso canale;
- il canale non deve essere occupato;
- il playback engine deve essere sbloccato da gesto utente;
- i volumi Android/WebView devono essere adeguati.

## File da non includere mai nei pacchetti pubblici

- `mobile-frontend/certs/*.pem`
- `mobile-frontend/certs/*-key.pem`
- `rootCA.pem` se non esplicitamente richiesto per installazione client
- `rootCA-key.pem`
- `.env` con segreti reali
- `node_modules/`
- `.gradle/`
- build intermedie Android pesanti, salvo APK finale richiesto

## Stato backup

Questo contesto e pensato per accompagnare un pacchetto composto da:

- sorgente V3 aggiornato;
- sorgente app Android/WebView;
- APK debug corrente;
- guida HTTPS;
- file task HTTPS originale;
- questo file di contesto.
