# Fase P3 - Secondary order writes scoped

Data: 2026-07-04

## Obiettivo

Continuare il Passo 3 della roadmap interinale P3 riducendo lavoro generico e
metriche opache nei flussi ordine secondari. Dopo il bulk integration restavano
alcune scritture `orders.appStateWrite` non distinguibili e alcuni percorsi
ordine non usavano ancora il writer puntuale.

## Modifiche

- `transfer/request`, `transfer/resolve` e `transfer/force` ora usano
  `writeIntegrationOrderSyncDb` con label dedicate:
  - `orders.transfer.request.appStateWrite`
  - `orders.transfer.resolve.appStateWrite`
  - `orders.transfer.force.appStateWrite`
- `orders/line/split` ora usa il writer puntuale con `orderIds` e audit ID
  espliciti.
- `orders/line/price-override` ora usa il writer puntuale con `orderIds`, audit
  ID espliciti e sync tavoli solo quando il ricalcolo finanziario cambia dati.
- `barChargeReplacement` ora sincronizza puntualmente ordine, audit, tavoli
  modificati e `barChargeReplacements`.
- I rami di rifiuto/conflitto di `correct/cancel` hanno metric label dedicate
  invece della label generica.
- Aggiunto guardrail statico: nessun `writeIntegrationOrderDb(db)` nudo deve
  rientrare nel backend.

## Verifiche

- `node --check backend/server.js`: OK
- `node --check backend/tests/route-policy-architecture.test.mjs`: OK
- `backend/tests/route-policy-architecture.test.mjs`: 45/45 OK
- `backend/tests/orders-flow.e2e.test.mjs`: 7/7 OK
- `backend/tests/runtime-metrics.test.mjs`: 5/5 OK
- `backend/tests/architecture-line-budget.test.mjs`: 1/1 OK
- `backend/tests/order-state-machine.test.mjs`: 17/17 OK
- `backend/tests/station-pause-transfer.e2e.test.mjs --test-name-pattern 'transfer|Trasfer'`: 13/13 OK
- `backend/tests/security.test.mjs --test-name-pattern 'line/price|public|auth'`: 30/30 OK

## Smoke

Run: `phaseP_interinale_p3_secondary_order_writes_smoke_12`

- Palmari/Postazioni: 12/6
- Operazioni per device: 5
- GUI: 0
- Fiscale reale: 0 tentativi
- Business ops: 90
- HTTP: 346
- Failure: 0
- Code finali `dbMutation/orderLane`: 0/0
- `order.create` p95: 1303 ms
- `order.sync.delivered` p95: 237 ms
- `station.heartbeat` p95: 727 ms
- `writeDb` totali: 24, nessun fallback generico ordine osservato nel campione

## Stato

Step promosso come pulizia/ottimizzazione dei flussi secondari. Lo smoke non
esercita tutte le nuove label, quindi il prossimo canary 50 dovra' confermare
se la riduzione delle scritture generiche abbassa anche la coda lunga P3 sotto
carico pieno.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_secondary_order_writes_smoke_12/report.json`
- `logs/loadtest-phaseP_interinale_p3_secondary_order_writes_smoke_12/REPORT.md`
