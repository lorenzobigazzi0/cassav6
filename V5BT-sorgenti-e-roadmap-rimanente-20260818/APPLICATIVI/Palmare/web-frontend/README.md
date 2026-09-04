# POS Frontend (React + TS)

## Requisiti

- Node.js 20.19+ (coerente con ESLint/Vitest installati)
- npm

## Avvio

```bash
npm install
npm run dev
```

Apri l'URL mostrato in console.

## HTTPS LAN per Radio PTT

Per usare il microfono da altri dispositivi sulla LAN, genera prima i certificati locali:

```powershell
npm run cert:lan
```

Per il solo sviluppo Vite in HTTPS locale su porta 5280:

```powershell
npm run dev:lan:https
```

Per il sistema completo V3, lo script `..\tools\start-cassav2-current.ps1` avvia lo static server
su HTTPS usando gli stessi certificati.

URL finale: `https://192.168.0.28:5280`.

Test microfono: `https://192.168.0.28:5280/mic-test.html`.

Dettagli e installazione CA client: `docs/lan-https.md`.

## Note

- Login fittizio (API mock) in `src/api/auth.ts`, attivo solo in dev/test o con
  `VITE_ENABLE_MOCK_AUTH=true`
- Stile glass in `src/styles/glass.css`
