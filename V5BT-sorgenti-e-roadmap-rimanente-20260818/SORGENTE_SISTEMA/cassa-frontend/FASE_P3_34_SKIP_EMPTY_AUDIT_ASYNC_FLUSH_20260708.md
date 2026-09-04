# Fase P3.34 - skip auditRecent vuoto nel flush async ordini

Data: 2026-07-08

## Obiettivo

Ridurre lavoro inutile nel mirror app-state asincrono degli ordini: quando un batch
`orders.asyncFlush` non contiene `auditEventIds`, non deve cadere nel fallback
`auditRecent`, a condizione che il profilo multiprocess abbia gia' promosso
l'audit workflow a ID espliciti.

## Modifiche

- `backend/server.js`
  - aggiunto flag `ORDERS_ASYNC_FLUSH_SKIP_EMPTY_AUDIT`;
  - prerequisiti effettivi:
    - `ORDERS_ASYNC_FLUSH_SKIP_EMPTY_AUDIT=1`;
    - `BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1`;
    - `DB_MODE=mysql`;
    - `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1`;
  - nel solo `orders.asyncFlush`, se `auditEventIds` e' vuoto, il mirror salta
    `syncOrderAuditEventsFastPath`;
  - i batch con audit esplicito continuano a sincronizzare gli eventi puntuali.
- `backend/modules/runtime-metrics.js`
  - aggiunto counter `ordersAsyncFlushEmptyAuditSkipped`.
- `deploy/systemd/50-p3-orders-write-primary.conf`
  - aggiunto `Environment=ORDERS_ASYNC_FLUSH_SKIP_EMPTY_AUDIT=1`.
- `backend/tests/route-policy-architecture.test.mjs`
  - aggiunto guardrail P3.34.
- `backend/tests/runtime-metrics.test.mjs`
  - aggiunto assert del nuovo counter nel monitor runtime.

Rollback: impostare `ORDERS_ASYNC_FLUSH_SKIP_EMPTY_AUDIT=0` o rimuovere la variabile
dalla drop-in systemd.

## Verifiche locali

- `node --check backend/server.js`: OK
- `node --check backend/modules/runtime-metrics.js`: OK
- `node --check backend/tests/route-policy-architecture.test.mjs`: OK
- `node --check backend/tests/runtime-metrics.test.mjs`: OK
- `node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs`: 92/92 OK
- `node --test backend/tests/runtime-metrics.test.mjs backend/tests/order-async-appstate-flush.test.mjs`: 13/13 OK
- `backend/server.js`: 38.793 righe

## Deploy Raspberry 192.168.0.67

File aggiornati in `/opt/cassav4/current/cassa-frontend`:

- `backend/server.js`
- `backend/modules/runtime-metrics.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/runtime-metrics.test.mjs`

Drop-in aggiornata:

- `/etc/systemd/system/cassav4-backend.service.d/50-p3-orders-write-primary.conf`
- `/etc/systemd/system/cassav4-api-worker@.service.d/50-p3-orders-write-primary.conf`

Servizi riavviati:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`
- `cassav4-battery.service`

Health post restart:

- `5280`: OK
- `5281`: OK
- `5282`: OK
- `5283`: OK
- `5284`: OK
- servizi systemd: tutti `active`
- log recenti backend/worker: nessun errore bloccante

## Verifiche su Raspberry

- `/usr/local/bin/node --check backend/server.js`: OK
- `/usr/local/bin/node --check backend/modules/runtime-metrics.js`: OK
- `/usr/local/bin/node --check backend/tests/route-policy-architecture.test.mjs`: OK
- `wc -l backend/server.js`: 38.793
- `/usr/local/bin/node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs`: 92/92 OK
- `/usr/local/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/order-async-appstate-flush.test.mjs`: 13/13 OK

## Canary

Primo tentativo:

- run: `p3_34_skip_empty_audit_c1_20_20260708`
- risultato: FAIL, 1/20
- causa: dataset di test con un solo tavolo libero; dopo il primo giro il tavolo
  resta `seated` con `covers=1`, `amountDue=0`, `pendingBills=[]`, quindi il
  canary automatico non trova altri tavoli liberi.
- il primo giro era corretto:
  - create: 200, `api-worker`, 787.28 ms
  - sync: 200, `api-worker`, 1109.35 ms
  - readback: 200, `api-worker`, 297.02 ms
  - cleanup: 200, `api-worker`, ordine `01606` `cancelled`, totale 0

Secondo tentativo con tavolo esplicito:

- run: `p3_34_explicit_table_c1_20_20260708`
- tavolo: `room_attesa_virtuale_t03`
- postazioni simulate: `BAR PRINCIPALE`, `CUCINA`
- stampa/fiscale/cassa reale: disattivati
- risultato: PASS, 20/20
- create p95: 672.63 ms
- sync p95: 1174.95 ms
- cleanup p95: 212.77 ms

Runtime metrics post-canary:

Worker `5283`:

- `ordersAsyncFlushEnqueued`: 31
- `ordersAsyncFlushCoalesced`: 10
- `ordersAsyncFlushBatches`: 21
- `ordersAsyncFlushRetries`: 0
- `ordersAsyncFlushBackpressureSync`: 0
- `ordersAsyncFlushPosSettingsTablesSkipped`: 21
- `ordersAsyncFlushEmptyAuditSkipped`: 0
- `ordersAsyncFlushPendingDepth`: 0
- `orders.asyncFlush.auditRecent`: count 21, p95 25 ms, max 43 ms

Worker `5284`:

- `ordersAsyncFlushEnqueued`: 32
- `ordersAsyncFlushCoalesced`: 9
- `ordersAsyncFlushBatches`: 23
- `ordersAsyncFlushRetries`: 0
- `ordersAsyncFlushBackpressureSync`: 0
- `ordersAsyncFlushPosSettingsTablesSkipped`: 21
- `ordersAsyncFlushEmptyAuditSkipped`: 2
- `ordersAsyncFlushPendingDepth`: 0
- `orders.asyncFlush.auditRecent`: count 21, p95 25 ms, max 43 ms

Owner `5281`:

- nessun batch async flush locale, coerente con routing worker del canary.

## Note

Il flag P3.34 e' stato esercitato: 2 batch vuoti audit sono stati saltati sul
worker `5284`. Nei batch con `auditEventIds` espliciti `auditRecent` resta
volutamente attivo.

Il prossimo step naturale resta spostare il mirror app-state ordini verso un
consumer/owner unico o ridurre il costo di `integrationBulk`; P3.34 elimina un
fallback inutile ma non sostituisce la centralizzazione del flush.
