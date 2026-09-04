# Fase F - Station Orders Load

Data: 2026-06-30

## Obiettivo

Eseguire mini-load 25/50 su `GET /api/integration/orders?station=...` dopo lo scoped read postazione, verificando stabilita' e latenza.

## Harness

- Nuovo script: `cassa-frontend/scripts/station-orders-scoped-load.mjs`.
- Parametri principali:
  - `STATION_LOAD_DEVICES`;
  - `STATION_LOAD_REQUESTS_PER_DEVICE`;
  - `STATION_LOAD_STATIONS`;
  - `STATION_LOAD_BASE_URL`.
- Output JSON/Markdown in `logs/station-scoped-load-*`.

## Primo risultato

Run iniziali con `BAR PRINCIPALE,BAR SECONDARIA`:

| Device | Richieste | Errori | p50 | p95 | p99 | Durata |
|---:|---:|---:|---:|---:|---:|---:|
| 25 | 500 | 0 | 2705 ms | 3079 ms | 3352 ms | 55.2 s |
| 50 | 1000 | 0 | 5304 ms | 6098 ms | 6314 ms | 107.9 s |

Diagnosi:

- Nessun fallback `scoped-reads` rilevato nei log.
- La GET postazione schedulava comunque troppe riconciliazioni background sotto polling intenso.
- Lo snapshot scoped leggeva ancora tutte le entry `integration.orders` prima del filtro applicativo.

## Correzioni applicate

- Repository MySQL split:
  - aggiunto `readObjectArrayFieldMatchingText(domain, fieldName, searchText, fallback)`.
  - La query legge la riga meta e solo le entry array il cui JSON contiene il testo cercato.
- Scoped orders:
  - quando la richiesta ha `station=...`, usa il nuovo metodo mirato se disponibile.
- Scheduler riconciliazione postazione:
  - aggiunto throttle per postazione a 1000 ms;
  - rimane la deduplica mentre un job e' gia' pendente.

## Risultato post-correzione

Run post-throttle con `BAR PRINCIPALE,BAR SECONDARIA`:

| Device | Richieste | Errori | p50 | p95 | p99 | Durata |
|---:|---:|---:|---:|---:|---:|---:|
| 25 | 500 | 0 | 1566 ms | 1822 ms | 1911 ms | 31.6 s |
| 50 | 1000 | 0 | 3068 ms | 3616 ms | 4055 ms | 62.1 s |

Delta:

- 25 device: p95 -40.8%, durata -42.8%.
- 50 device: p95 -40.7%, durata -42.4%.
- Errori HTTP: 0 in tutti i run.

## Limiti della misura

- Le runtime metrics interne non sono state acquisite dal live perche' `/api/monitor/runtime-metrics` richiede sessione admin e i login provati non erano validi o erano in rate limit.
- `RUNTIME_METRICS=1` era attivo, ma lo script ha registrato `loginOk=false` e `metricsAvailable=false`.
- Per `BAR-1`, il filtro testuale non riduce il set perche' tutti i 163 ordini correnti contengono `BAR-1`; serve un indice/criterio piu' strutturato per ridurre davvero quel caso.

## Verifiche

Comandi principali eseguiti:

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/integration/scoped-orders-read.js`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs cassa-frontend/backend/tests/scoped-orders-read.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/app-state-repository.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/postazione-preparation-selection.e2e.test.mjs cassa-frontend/backend/tests/integration-current-table-session.test.mjs`
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Risultato:

- Scoped orders + scheduler: 8/8 pass.
- App-state repository: 31/31 pass.
- Postazione/current session: 4/4 pass.
- Route policy + runtime metrics: 9/9 pass.

## Prossimo step consigliato

Per chiudere Fase F sulla vista postazione:

- aggiungere indice strutturato per ordini per postazione, non solo `LIKE` sul JSON;
- oppure mantenere una cache hot per `orders?station=...` invalidata dagli eventi push;
- ripetere il mini-load con sessione admin valida per raccogliere `readDb`, `writeDb`, `orderLaneEnqueued` e profondita' code.
