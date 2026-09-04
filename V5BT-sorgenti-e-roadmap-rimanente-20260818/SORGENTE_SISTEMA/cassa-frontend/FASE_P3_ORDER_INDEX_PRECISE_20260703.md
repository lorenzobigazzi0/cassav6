# Fase P3.15 - indice ordini/postazioni selettivo

Data: 2026-07-03

## Obiettivo

Chiudere il retry residuo del run P3.14 su:

- `integration.orders.entries.errorStage.orderStationIndex.transientDbError`
- `integration.orders.entries.rollback.cause.transientDbError`

senza allargare la finestra di lock del workflow ordini.

## Modifica

File:

- `backend/db/app-state/mysql-domains-split.repository.js`
- `backend/tests/app-state-repository.test.mjs`

La sync incrementale dell'indice `app_state_domain_records_order_station_index`
non cancella piu' tutte le righe dell'ordine cambiato. Ora:

1. legge l'indice precedente per gli ordini toccati;
2. confronta le chiavi `(station, match_kind)` effettivamente rimaste valide;
3. fa upsert delle righe nuove/ancora valide;
4. cancella solo le chiavi obsolete via primary-key tuple:
   `(station, match_kind, order_record_id)`.

Questo evita delete larghi per `order_record_id` e riduce i lock inutili sulle
righe di indice ancora valide.

## Test

Verifiche locali:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/app-state-repository.test.mjs --test-name-pattern='indice|rollback transient|orders upsert|dirty'
```

Risultato:

- architettura/runtime: 37/37 pass
- app-state repository: 38/38 pass

Nota: il filtro `--test-name-pattern` non limita tutti i subtest in questo
runner; il giro app-state ha comunque chiuso 38/38.

## Load 50 stabile

Run:

- `logs/loadtest-phaseP_v5_p315_orderindex_precise_50/REPORT.md`
- `logs/loadtest-phaseP_v5_p315_orderindex_precise_50/report.json`

Risultati:

- durata: 262 s
- business ops: 1260
- HTTP: 3231
- failure: 0
- RT virtuale: 3/3 successi HTTP
- coda finale `dbMutation/orderLane`: 0 / 0
- nessun `orderStationIndex` transient
- nessun `appStateWriteRetry`
- nessun `Hook pre-write app-state`
- indice ordini:
  - `integration.orders.index.total`: avg 31.27 ms, p95 <=250 ms, max 556 ms
  - `integration.orders.index.insertRows`: avg 13.72 ms, p95 <=100 ms

Latenze ancora alte per attesa in `order-lane`:

- `order.create`: p95 21743 ms
- `order.sync.ready`: p95 22912 ms
- `order.sync.delivered`: p95 21899 ms
- `payment.free_split`: p95 19066 ms
- `reservation.create`: p95 24208 ms

## Probe scartato: order lane default 8

Run:

- `logs/loadtest-phaseP_v5_p316_orderlane8_default_50/REPORT.md`
- `logs/loadtest-phaseP_v5_p316_orderlane8_default_50/report.json`

Risultati positivi:

- durata: 229 s
- failure: 0
- max `orderLaneRunning`: 8
- DB written approx: 197.81 MB

Motivo per cui non e' stato promosso:

- il log ha reintrodotto 1 retry transient:
  - `Hook pre-write app-state fallito: Deadlock found when trying to get lock`
  - `Write app-state MySQL in retry dopo errore transient (1/3)`

Decisione:

- default produzione lasciato a 6 worker;
- 8 resta canary sperimentale da riprovare solo dopo riduzione del peso della
  singola write ordine/app-state.

## Stato

Il retry specifico `orderStationIndex` e' chiuso nel run stabile P3.15.
Il collo residuo P3 non e' piu' la correttezza dell'indice, ma la latenza da
attesa in `order-lane` sotto burst 50 device.

## Prossimo passo consigliato

Ridurre il tempo della singola write ordine prima di riaumentare la concorrenza:

1. portare `comp/correct/cancel` sullo stesso fast path puntuale di
   `writeIntegrationOrderSyncDb`;
2. ridurre `auditRecent` evitando fallback recent/full quando sono disponibili
   ID espliciti o quando non sono stati aggiunti audit event;
3. ripetere load-50 a default 6;
4. solo dopo un run senza retry, riprovare `ORDER_SYNC_FAST_LANE_CONCURRENCY=8`.
