# Fase P3.25 - CPU profile order worker

## Obiettivo

Profilare gli api-worker multi-processo sul Raspberry target `192.168.0.67` dopo P3.24, con stampa/fiscale/cassa reale disattivati, per individuare i costi sincroni rimasti nel percorso `orders/create -> orders/sync -> orders/cancel`.

## Modifiche

- Aggiunto `scripts/cpu-profile-summary.mjs` per leggere profili V8 `.cpuprofile` e produrre top frame/file applicativi.
- Aggiunto `scripts/cancel-order-by-api.mjs` per cleanup puntuale via API durante diagnostica.
- Aggiunta guardia in `scripts/order-worker-sync-e2e-canary.mjs`: con cleanup obbligatorio, workflow non annullabili (`ready`, `delivered`) vengono bloccati prima di creare ordini.
- Aggiornato `scripts/order-worker-sync-e2e-batch-canary.test.mjs` per coprire la nuova guardia.

## Ambiente target

- Host: `192.168.0.67`
- Servizi: `cassav4-backend`, `cassav4-api-worker@5283`, `cassav4-api-worker@5284`
- Profiling temporaneo: `NODE_OPTIONS=--cpu-prof --cpu-prof-dir=...` solo sugli api-worker, rimosso a fine run.
- I/O reale disattivato:
  - `PRINTING_ENABLED=0`
  - `BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0`
  - `AUTOMATIC_CASH_GATEWAY_ENABLED=0`
  - `CASSAV4_TEST_DISABLE_REAL_IO=1`
  - `FISCAL_REAL_IO_DISABLED=1`

## Evidenza finale

Run finale:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_25_cpu_profile_prep_c3_50x_20260708`

Risultato:

| Metrica | Valore |
| --- | --- |
| Esito | PASS |
| OK | 50/50 |
| Durata | 83105.91 ms |
| create p95 | 1418.45 ms |
| sync p95 | 1092.05 ms |
| readback p95 | 446.15 ms |
| cleanup p95 | 1082.02 ms |
| create/sync/readback/cleanup role | api-worker 50/50 |
| residui ordini attivi | 0 |
| residui lock gazebo | 0 |

Profili CPU finali:

- `CPU_PROFILE_SUMMARY.md`
- `cpu-profile-summary.json`
- `cpu-profiles/*.cpuprofile`

## Top CPU applicativa

Campione finale: 2 profili, 233393.69 ms CPU campionata, 154400 sample.

| Frame/File | Self ms | % |
| --- | ---: | ---: |
| `backend/server.js:2817 cloneJson` | 10199.52 | 4.37 |
| `backend/server.js:9218 sanitizeIntegrationOrder` | 7600.31 | 3.26 |
| `backend/db/relational/orders.repo.js:3 safeJsonParse` | 6435.38 | 2.76 |
| `backend/modules/audit/audit.mapper.js:5 cloneJson` | 5278.78 | 2.26 |
| `backend/modules/price-lists/price-lists.domain.js:78 getMenuPriceScheduleMinutes` | 4987.31 | 2.14 |
| `backend/modules/audit/audit.mapper.js:55 anonymous mapper` | 3930.65 | 1.68 |
| `backend/integration/integration-utils.js:72 normalizeIntegrationStationToken` | 3716.20 | 1.59 |
| `backend/db/relational/orders.repo.js:521 listOrders` | 2790.94 | 1.20 |
| `backend/db/relational/orders.repo.js:926 hydrateOrder` | 2431.08 | 1.04 |

Top file:

| File | Self ms | % |
| --- | ---: | ---: |
| `backend/server.js` | 37208.42 | 15.94 |
| `backend/db/relational/orders.repo.js` | 13345.67 | 5.72 |
| `backend/modules/audit/audit.mapper.js` | 10986.00 | 4.71 |
| `backend/integration/integration-utils.js` | 5306.13 | 2.27 |
| `backend/modules/price-lists/price-lists.domain.js` | 5223.99 | 2.24 |

## Note diagnostiche

- Il primo C5/50 in `prep` ha fatto 49/50: un child ha ricevuto `PREPARATION_QUEUE_FULL` per la regola reale "massimo 3 comande in preparazione su questa postazione". Non e' stato usato come gate, ma ha confermato lo stesso profilo CPU.
- Il tentativo C5/50 con `ready` ha evidenziato un bug della canary: `ready` non e' annullabile via `/orders/cancel`, quindi il cleanup non deve essere richiesto in quel modo. La guardia introdotta ora blocca questa combinazione prima di creare dati.
- I residui del run `ready` sono stati rimossi in modo mirato: ordini app-state, indice station, fulfillment history e righe SQLite relazionali degli stessi order id. Verifica finale: 0 ordini attivi, 0 lock.

## Interpretazione

Il collo non e' piu' il mirror I/O sul percorso risposta: il profilo conferma costo CPU ripetuto in clone/sanitize/parse/idratation/audit. Le prime ottimizzazioni consigliate sono:

1. Ridurre `cloneJson` e `sanitizeIntegrationOrder` nel path create/sync/cancel, evitando deep clone ripetuti di ordini gia' normalizzati.
2. Ridurre parse/idratation in `orders.repo`: `safeJsonParse`, `listOrders`, `hydrateOrder` sono costi rilevanti anche su C3.
3. Rendere piu' leggero `audit.mapper`: clone e mapping eventi pesano quasi quanto il repo ordini.
4. Cache o precomputazione per `getMenuPriceScheduleMinutes`, chiamato in modo ripetitivo durante il canary.

Questa fase non chiude ancora il gate numerico P3 (<500 ms p95), ma produce il profilo operativo necessario per abbattere i top costi CPU senza procedere alla cieca.

## Verifiche eseguite

- `node --test scripts/order-worker-sync-e2e-batch-canary.test.mjs` sul target: PASS 2/2.
- Guard probe `CANARY_SYNC_WORKFLOW_STATUS=ready` dopo deploy: bloccato prima di create, nessun ordine generato.
- C3/50 finale: PASS 50/50.
- Servizi post-run: `cassav4-backend`, `cassav4-api-worker@5283`, `cassav4-api-worker@5284` active.
- Health post-run: `https://127.0.0.1:5280/api/health` HTTP 200.
