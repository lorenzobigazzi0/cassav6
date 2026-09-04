# Fase P3.28 - Scoped Order Workflow Snapshot

Data: 2026-07-08
Target: Raspberry `192.168.0.67`, deploy `/opt/cassav4/current/cassa-frontend`

## Obiettivo

Ridurre il costo degli snapshot relazionali usati nei ricalcoli economici ordini, evitando letture complete quando il flusso riguarda un singolo tavolo o un insieme noto di tavoli collegati.

## Modifiche

- `listRelationalOrderWorkflowSnapshot` ora accetta `orderId`, `tableId`, `tableIds`.
- Se non viene passato uno scope, il comportamento resta invariato e legge tutti gli ordini.
- I call-site economici post-write di create, price override, bar replacement, comp, correct e cancel passano snapshot limitati ai tavoli interessati, includendo anche tavoli collegati tramite `resolveIntegrationLinkedTableIds`.
- Lo snapshot workflow principale di `orders/sync` resta completo, per non alterare coda, lane e limiti di preparazione.
- Corretto anche un bug emerso dal canary: il cancel idempotente, quando incorpora una revisione relazionale gia' `cancelled`, ora rende durevole il mirror app-state MySQL prima di rispondere.

## Test

- `node --check backend/modules/integration/relational-order-create.js`
- `node --check backend/server.js`
- `node --test backend/tests/relational-orders.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/order-financial-sync-source.test.mjs`
  - Esito: 114/114 pass
- Test mirati snapshot:
  - `listRelationalOrderWorkflowSnapshot espone sorgente relazionale per orders/sync`
  - `listRelationalOrderWorkflowSnapshot limita gli ordini per scope tavolo e ordine`

## Canary

Run iniziale con utente errato:

- `p3_28_scoped_order_snapshot_c3_50x_20260708`
- Esito: fail 0/50, causa `lorenzo/1234` non presente nel dataset target; rate-limit dopo tentativi falliti.

Run con utente corretto ma senza tavoli espliciti:

- `p3_28_scoped_order_snapshot_c3_50x_amalia_20260708`
- Esito: fail 4/50, causa fixture: tutti i tavoli erano `seated` e il canary automatico non trovava tavoli `free`; residui canary storici causavano anche limite massimo 3 in preparazione.
- Azione: cancellati via API 26 residui P3.28 + 3 residui storici `canary orders/sync`.

Run con tavoli espliciti:

- `p3_28_scoped_order_snapshot_c3_50x_scopedtables_20260708`
- Esito: PASS 50/50
- Create p95: 1785.58 ms
- Sync p95: 2046.04 ms
- Cleanup p95: 1592.72 ms
- Readback p95: 612.42 ms

Run finale post-fix idempotent cancel:

- `p3_28_scoped_order_snapshot_c3_50x_postfix_20260708`
- Esito: PASS 50/50
- Create p95: 2648.42 ms
- Sync p95: 1773.45 ms
- Cleanup p95: 1279.94 ms
- Readback p95: 838.22 ms
- Residui finali: active canary 0, lock 0

## Stato Finale

- Servizi target active: backend, api-worker 5283, api-worker 5284, realtime, frontend, battery.
- Health: `{"ok":true,"service":"cash-backend","database":{"ok":true,"mode":"mysql"}}`
- I/O reale resta disattivato da env: stampa, fiscale e cassa automatica reale non usati.

## Note Per Step Successivo

P3.28 riduce il lavoro inutile sugli snapshot economici, ma le latenze C3/50 restano >1s p95 su Raspberry/dataset commerciale. Il prossimo step dovrebbe continuare sul costo CPU/event-loop: fan-out realtime/SSE, sanitize/hydrate ordini, e readback/layout su worker.
