# Ultimate package

Data creazione: 2026-06-04

## Contenuto

Questo archivio contiene il workspace necessario per lavorare sul sistema da un'altra postazione:

- backend e frontend cassa in `cassa-frontend`;
- frontend mobile in `mobile-frontend`;
- frontend impostazioni in `settings-frontend`;
- frontend monitor in `monitor-frontend`;
- postazione in `postazione`;
- prenotazioni in `reservation-frontend`;
- server statico/proxy in `serve-frontends.mjs`;
- stato applicativo JSON corrente in `cassa-frontend/backend/app-state.json`;
- memorie architetturali e documentazione operative.

Non include dipendenze installabili, log runtime o risultati test temporanei.

## Avvio rapido

Richiede Node.js moderno.

Installare dipendenze dove servono:

```powershell
cd cassa-frontend
npm install
cd ..\mobile-frontend
npm install
cd ..
```

Avviare backend:

```powershell
cd cassa-frontend
$env:PORT='5181'
$env:HOST='0.0.0.0'
node backend/server.js
```

Avviare frontend statici/proxy in un secondo terminale:

```powershell
$env:FRONTEND_PORT='5180'
$env:FRONTEND_HOST='0.0.0.0'
$env:BACKEND_ORIGIN='http://127.0.0.1:5181'
node serve-frontends.mjs
```

URL principali:

- Impostazioni: `http://127.0.0.1:5180/impostazioni/`
- Mobile: `http://127.0.0.1:5180/mobile/`
- Cassa: `http://127.0.0.1:5180/cassa/`
- Postazione: `http://127.0.0.1:5180/postazione/`
- Monitor: `http://127.0.0.1:5180/monitor/`

Admin locale configurato:

- username: `admin`
- PIN: `123456`

## Note

Il frontend impostazioni e alcune postazioni sono patchate nel `dist` perche' in workspace non sono disponibili tutti i sorgenti/build originali. Non cancellare i dist.

