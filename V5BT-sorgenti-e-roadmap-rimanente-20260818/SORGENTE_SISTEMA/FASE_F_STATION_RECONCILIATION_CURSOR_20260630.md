# Fase F - Cursor riconciliazione ordini postazione

Data: 2026-06-30

## Obiettivo

Ridurre l'impatto residuo della riconciliazione asincrona avviata da
`GET /api/integration/orders?station=...`. Dopo il pre-limit, la GET era veloce
ma poteva ancora svegliare la lane ordini usando `integration.lastWriteAt`, che
cambia anche per heartbeat postazione, session status e rumore fiscale.

## Implementato

- Aggiunto `buildStationOrdersPollReconciliationCursor(orders)`.
- Il cursor considera solo dati ordine rilevanti per la vista postazione:
  - id;
  - timestamp ordine;
  - workflow/payment/assignment status;
  - station/owner/lock;
  - route di riga;
  - righe articolo, quantita, void/correction status.
- La GET postazione passa allo scheduler il cursor degli ordini letti, non
  `integration.lastWriteAt`.
- Lo scheduler ora:
  - non rischedula una versione gia riconciliata per la stessa postazione;
  - se arriva una versione nuova mentre un job e pendente, accorpa tutto in un
    solo job finale;
  - mantiene il throttle esistente per i casi senza cursor.

## File modificati

- `cassa-frontend/backend/modules/integration/station-orders-reconciliation.js`
- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs`

## Verifiche

Comandi eseguiti:

- `node --check cassa-frontend/backend/modules/integration/station-orders-reconciliation.js`
- `node --check cassa-frontend/backend/server.js`
- `node --test cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs cassa-frontend/backend/tests/scoped-orders-read.test.mjs cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Risultato:

- 16 test passati, 0 falliti.
- Backend/frontend riavviati:
  - Mobile: `https://192.168.0.74:5280/mobile/`
  - Postazione: `https://192.168.0.74:5280/postazione/`
  - Backend: `http://127.0.0.1:5281/api/health`

## Mini-load

Scenario: `BAR-1`, `doneHistoryLimit=8`.

| Run | Device | Richieste | Errori | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `station-recon-order-cursor-25` | 25 | 500 | 0 | 68.4 ms | 479.7 ms | 1844.2 ms | 2291.9 ms |
| `station-recon-order-cursor-50` | 50 | 1000 | 0 | 87.0 ms | 796.7 ms | 3801.3 ms | 4458.2 ms |

Report:

- `logs/station-scoped-load-station-recon-order-cursor-25-25/REPORT.md`
- `logs/station-scoped-load-station-recon-order-cursor-50-50/REPORT.md`

## Esito

Durante 1500 richieste postazione sono rimaste solo 2 attese lunghe della
riconciliazione ordini postazione, invece di una raffica legata ai device.
Il p95 resta sotto il secondo anche a 50 device nel test breve.

## Residuo

Gli outlier p99 non sono piu dominati dalla GET ordini postazione. Nei log del
run restano attese lunghe su:

- `POST /api/integration/stations/state`;
- `POST /api/auth/session/status`;
- retry fiscale pendente `fiscal_pos_status_error_*`.

## Prossimo step consigliato

Continuare Fase F/B sul path `stations/state` e `auth/session/status`, portando
lo stato postazione fuori dalla coda globale in modo piu completo o rendendolo
interamente per-record quando non ci sono cambi operativi reali.
