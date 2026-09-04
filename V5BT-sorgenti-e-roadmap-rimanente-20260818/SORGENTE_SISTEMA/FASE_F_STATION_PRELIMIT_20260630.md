# Fase F - pre-limit lettura comande postazione

Data: 2026-06-30

## Obiettivo

Ridurre il costo dei cache miss sulla lettura `GET /api/integration/orders`
usata dalle postazioni. La postazione chiede solo uno storico recente, ma prima
la pipeline poteva ricevere tutto lo storico della postazione e normalizzarlo
prima del taglio finale.

## Modifiche

- `cassa-frontend/backend/modules/integration/scoped-orders-read.js`
  - aggiunto pre-limit dello storico postazione gia nella lettura scoped;
  - attivo solo con `station` + `includeDone=1`;
  - bypass se la richiesta cerca una comanda precisa (`orderId`/`id`);
  - bypass se la richiesta filtra una sala (`roomId`);
  - default compatibilita: se manca `doneHistoryLimit`/`historyLimit`, viene
    applicato e propagato `doneHistoryLimit=30`.
- `cassa-frontend/backend/tests/scoped-orders-read.test.mjs`
  - copertura per limit esplicito;
  - copertura per bypass su comanda specifica;
  - copertura per default 30 senza parametro.

Nota: `cassa-frontend/backend/server.js` non e stato modificato ed e rimasto a
39988 righe.

## Verifiche funzionali

- `node --check cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `node --test cassa-frontend/backend/tests/scoped-orders-read.test.mjs cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`
  - 8 test passati, 0 falliti.

## Smoke live

Sistema riavviato su:

- Mobile: `https://192.168.0.74:5280/mobile/`
- Postazione: `https://192.168.0.74:5280/postazione/`
- Backend: `http://127.0.0.1:5281/api/health`

Endpoint postazione:

- `station=BAR-1&includeDone=1&includeTransferred=1&doneHistoryLimit=8`
  - `200`, 8 ordini, 55606 byte, ids `00342` ... `00349`.
- `station=BAR-1&includeDone=1&includeTransferred=1`
  - `200`, 30 ordini, 213815 byte, ids `00320` ... `00349`.

Il secondo caso prima del fix rispondeva con 0 ordini.

## Mini-load

Scenario: 25 device simulati, 20 richieste per device, `BAR-1`,
`doneHistoryLimit=8`, totale 500 richieste.

Run `station-prelimit-final-25`:

- errori: 0
- p50: 90.7 ms
- p95: 285.0 ms
- p99: 1803.6 ms
- media: 151.8 ms
- max: 2110.8 ms

Run `station-prelimit-final-hot-25`:

- errori: 0
- p50: 68.0 ms
- p95: 795.0 ms
- p99: 2317.8 ms
- media: 166.2 ms
- max: 2749.8 ms

Report generati:

- `logs/station-scoped-load-station-prelimit-final-25-25/REPORT.md`
- `logs/station-scoped-load-station-prelimit-final-hot-25-25/REPORT.md`

## Confronto con step precedente

Prima del pre-limit finale:

- payload full non scoped/storico: 1188061 byte;
- payload postazione limit 8: circa 48550-55606 byte;
- mini-load cache postazione precedente: p50 circa 197.7 ms, p95 circa 2727.3 ms.

Dopo il pre-limit finale:

- payload limit 8 resta piccolo: 55606 byte;
- fallback senza parametro non torna piu vuoto: 30 ordini;
- p50 scende a 68-91 ms;
- p95 osservato tra 285 e 795 ms.

## Residuo

Restano outlier p99 sopra 1.8-2.3 s sotto burst. Dai log live si vedono ancora
alcune code lunghe non legate solo alla GET postazione, in particolare
riconciliazioni/stato sessione e retry fiscali pendenti. Il prossimo step utile
e ridurre o disaccoppiare le riconciliazioni `GET /api/integration/orders station
reconciliation` dalla coda che impatta i burst.
