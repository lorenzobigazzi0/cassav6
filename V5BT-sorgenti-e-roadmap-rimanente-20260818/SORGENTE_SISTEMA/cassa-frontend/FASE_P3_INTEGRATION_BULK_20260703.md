# Fase P3 - Integration Bulk Sync

Data: 2026-07-03

## Obiettivo

Ridurre il numero di acquisizioni MySQL e di scritture separate nel percorso caldo ordini accorpando, quando possibile, `integration.orders`, `integration.notifications`, `integration.orderFulfillmentHistory`, `integration.lastWriteAt` e `integration.sequence` in una sola transazione domain-split.

## Modifiche applicate

- Aggiunto `syncObjectArrayEntriesAndObjectEntriesFromAppState` in `backend/db/app-state/mysql-domains-split.repository.js`.
- Aggiornato `writeIntegrationOrderSyncDb` in `backend/server.js` per usare lo step unico `mysql.integrationBulk` sui flussi order create/sync.
- Mantenuti fallback espliciti per notifiche e fulfillment history quando non si puo usare il bulk.
- Aggiornate le metriche e le policy test per il nuovo label `orderWorkflowStep:*.mysql.integrationBulk`.
- Durante il canary e stato trovato un 401 intermittente sulle postazioni quando lo stesso operatore era loggato su piu device `postazione`.
- Corretto `enforceLoginSessionPolicy`: ora la sessione e stabile per device su tutti i frontend device-aware; il login revoca solo il token precedente dello stesso terminale. I conflitti di occupazione della postazione restano in `assertWorkstationLoginAvailable`.

## Verifiche automatiche

- `node --check backend/server.js`: OK.
- `node --check backend/db/app-state/mysql-domains-split.repository.js`: OK.
- `node --check backend/tests/security.test.mjs`: OK.
- `backend/tests/route-policy-architecture.test.mjs`: 44/44 OK.
- `backend/tests/security.test.mjs`: 30/30 OK.
- `backend/tests/orders-flow.e2e.test.mjs`: 7/7 OK.
- `backend/tests/runtime-metrics.test.mjs`: 5/5 OK.
- `backend/tests/app-state-repository.test.mjs --test-name-pattern "accorpa entries"`: 1/1 OK.
- `backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Load test

Smoke:

- Run: `phaseP_interinale_p3_integration_bulk_smoke_20`
- Palmari/Postazioni: 20/10
- Operazioni business: 180
- Richieste HTTP: 511
- Failure: 0
- Code finali `dbMutation/orderLane`: 0/0

Canary iniziale:

- Run: `phaseP_interinale_p3_integration_bulk_canary12_50`
- Palmari/Postazioni: 50/12
- Operazioni business: 744
- Failure: 1
- Anomalia: `order.sync.ready` 401, sessione postazione revocata da login dello stesso operatore su un altro device.

Canary post-fix:

- Run: `phaseP_interinale_p3_integration_bulk_canary12_50_authfix`
- Palmari/Postazioni: 50/12
- Operazioni business: 744
- Richieste HTTP: 1753
- Failure: 0
- DB written approx: 71.01 MB
- Righe inserite/aggiornate/eliminate: 5684 / 4618 / 3161
- Code finali `dbMutation/orderLane`: 0/0
- `appStateDomainSplit:integration.bulkEntries.beginTransaction`: count 261, avg 17.72 ms, p95 bucket <=50 ms, max 125 ms.
- `appStateDomainSplit:integration.bulkEntries.commit`: count 261, avg 15.94 ms, p95 bucket <=50 ms, max 121 ms.
- `appStateDomainSplit:integration.bulkEntries.ensure`: count 261, avg 50.15 ms, p95 bucket <=500 ms, max 568 ms.
- `appStateDomainSplit:integration.orders.index.total`: count 310, avg 17.41 ms, p95 bucket <=100 ms, max 158 ms.
- `order.create`: 142/142 OK, p95 12248 ms.
- `order.sync.ready`: 43/43 OK, p95 11374 ms.
- `order.sync.delivered`: 61/61 OK, p95 12003 ms.
- `station.heartbeat`: 209/209 OK, p95 13077 ms.

## Decisione

Step promosso.

Il bulk riduce le scritture separate nel percorso ordini e il canary post-fix non mostra errori o code residue. Restano alte le latenze end-to-end sotto canary pieno per order lane e heartbeat, ma non sono peggiorate da failure o accumuli finali; il prossimo step deve agire sulla contesa della lane/heartbeat e non sulla correttezza della transazione bulk.

## File report load

- `logs/loadtest-phaseP_interinale_p3_integration_bulk_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_integration_bulk_canary12_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_integration_bulk_canary12_50_authfix/REPORT.md`
