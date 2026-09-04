# Fase P3.64 - order_created lean payload

Data: 2026-07-09

## Obiettivo

Ridurre il costo residuo dello stage `orderCreateInternal:realtimePublish` dopo P3.63. Il publish inline era gia' disattivato, ma l'ACK di `orders/create` continuava a pagare la costruzione e serializzazione di un payload `order_created` molto grande.

## Modifica

- `orders/create` invia in outbox un payload realtime leggero quando sono attivi write-primary relazionale e `EVENT_OUTBOX_ENABLED`.
- Il payload mantiene `orderId`, `tableId`, `tableNumber`, `roomId`, `station`, `ownerStation`, `revision`, `total`, `itemCount` e `payloadMode: "lean"`.
- Non include piu' `detail.order` e `detail.table` nel percorso caldo.
- Rollback: `BACKEND_ORDERS_CREATE_REALTIME_LEAN_PAYLOAD=0`.

## File Modificati

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/realtime-event-outbox.e2e.test.mjs`

## Verifiche

Sul Raspberry `192.168.0.67`:

- `node --test backend/tests/route-policy-architecture.test.mjs`: 111/111 PASS
- `node --test backend/tests/architecture-line-budget.test.mjs`: 1/1 PASS
- `PRINTING_ENABLED=0 FISCAL_REAL_IO_DISABLED=1 POS_FISCAL_REAL_IO_DISABLED=1 AUTOMATIC_CASH_REAL_ENABLED=0 node --test backend/tests/realtime-event-outbox.e2e.test.mjs`: 9/9 PASS

Servizi riavviati e health OK su:

- `http://127.0.0.1:5281/api/health`
- `http://127.0.0.1:5283/api/health`
- `http://127.0.0.1:5284/api/health`
- `https://127.0.0.1:5280/api/health`

## Canary 50 Device

Run: `p3_64_order_created_lean_payload_c1_50_20260709`

- Esito: 50/50 PASS
- `create p95`: 755.02 ms
- `create avg`: 501.88 ms
- `sync p95`: 499.06 ms
- `readback p95`: 462.82 ms
- `cleanup p95`: 608.77 ms

Confronto P3.63:

- `create p95`: 995.59 ms -> 755.02 ms, miglioramento 240.57 ms (-24.16%)
- `create avg`: 762.01 ms -> 501.88 ms, miglioramento 260.13 ms

## Breakdown Dopo Fix

`orderCreateInternal:realtimePublish`:

- P3.63: circa 274-278 ms medi per worker
- P3.64: 2.76 ms su worker 5283, 0.96 ms su worker 5284

Nuovi top costi medi:

- `financialSync`: circa 170-174 ms
- `auditPrelude`: circa 111-113 ms
- `financialSnapshotRead`: circa 96-98 ms

## Note Operative

- `eventOutboxPublishRuns` sui worker resta 0: l'ACK non pubblica inline.
- Owner outbox: 190 eventi pubblicati, 0 failure.
- Redis: 336 invalidazioni, 9 coalesced, 0 errori.
- Warning post-canary: solo log attesi di avvio/sicurezza (`STAMPA DISABILITATA`, I/O fiscale reale disabilitato).

## Prossimo Step

P3.65: intervenire sul nuovo collo di bottiglia `financialSync` in `orders/create`, evitando la scansione/ricostruzione economica completa quando il create riguarda un solo tavolo e il delta della nuova comanda e' gia' noto.
