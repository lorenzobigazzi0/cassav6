# Fase P3.29 - orders/sync snapshot relazionale scoped per postazione

Data: 2026-07-08
Target: Raspberry `192.168.0.67`

## Obiettivo

Ridurre il lavoro sincrono di `POST /api/integration/orders/sync` nel percorso multi-processo evitando la lettura completa degli ordini relazionali quando la postazione/canale dell'ordine e' nota.

## Implementazione

- `listRelationalOrderWorkflowSnapshot` accetta ora `stationId` / `stationIds` oltre a `orderId` e `tableId` / `tableIds`.
- Gli snapshot relazionali parziali sono marcati con `scoped: true`.
- `orders/sync` calcola gli station id dal payload (`assignedStationId`, `ownerStation`, `stationId`, `station`) e legge dal relazionale solo:
  - l'ordine target;
  - gli ordini della stessa postazione/lane.
- Se lo snapshot e' scoped, `orders/sync` fonde il risultato nel cache completo tramite `mergeIntegrationOrderWorkflowScopedOrders` invece di sostituire tutta `db.integration.orders`.
- Se manca la postazione, resta il fallback precedente con snapshot completo per non falsare limite coda/demotion.

## File modificati

- `backend/modules/integration/relational-order-create.js`
- `backend/modules/orders/order-preparation-queue.js`
- `backend/server.js`
- `backend/tests/order-preparation-queue.test.mjs`
- `backend/tests/relational-orders.test.mjs`
- `backend/tests/route-policy-architecture.test.mjs`

## Verifiche

Eseguite sul target `192.168.0.67` come utente servizio `cassav4`.

- `node --check` su moduli e `backend/server.js`: OK
- Test mirati:
  - `backend/tests/order-preparation-queue.test.mjs`
  - `backend/tests/relational-orders.test.mjs`
  - `backend/tests/route-policy-architecture.test.mjs`
  - `backend/tests/order-financial-sync-source.test.mjs`
- Risultato test: 144/144 pass
- `backend/server.js`: 38.790 righe, margine budget architetturale 710 righe.

## Canary

Run: `p3_29_order_sync_station_snapshot_c3_50x_20260708`

- Iterazioni: 50
- Concorrenza: 3
- Create proxy role: `api-worker`
- Sync proxy role: `api-worker`
- I/O reale disabilitato: stampa, fiscale, cassa automatica

Risultato:

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 | 0 | 1968.54 ms | 2890.27 ms | 2066.33 ms | 1271.69 ms |

Report canary:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_29_order_sync_station_snapshot_c3_50x_20260708`

Pulizia finale:

- Ordini canary relazionali del run: 50
- Ordini canary ancora attivi: 0
- Lock MySQL `app_table_work_locks`: 0

## Note operative

Durante il canary il journal ha mostrato molte righe `Nessuna postazione attiva ... no_eligible_active_station`. Questo rende il run valido per correttezza multi-processo, ma meno pulito come misura del beneficio sulla lane per postazione, perche' parte dei payload non ha una postazione attiva reale da usare come scope operativo pieno.

Il `createP95` e' migliorato rispetto al run P3.28 annotato in handover, mentre `syncP95` e' rimasto alto in questo run. Non risultano ordini o lock residui.

## Prossimo step consigliato

Eseguire un canary con almeno 2 postazioni attive reali/simulate prima del batch, cosi' gli ordini entrano in lane concrete e lo scope `stationIds` misura il caso previsto. Se il `syncP95` resta alto, il prossimo intervento va sulla CPU residua del path sync: route transitions, audit diff/item progress e fan-out realtime/outbox.
