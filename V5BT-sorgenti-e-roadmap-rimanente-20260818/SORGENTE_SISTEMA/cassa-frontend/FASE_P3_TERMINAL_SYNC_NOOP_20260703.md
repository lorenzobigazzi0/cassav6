# Fase P3 - Terminal Sync No-op

## Obiettivo

Verificare il passo successivo della roadmap P3 dopo i bucket workflow: ridurre lavoro inutile quando una postazione reinvia una sync gia' terminale su una comanda gia' consegnata.

## Modifiche

- Aggiunto no-op idempotente in `backend/server.js` per sync duplicate terminali:
  - `currentOrder.workflowStatus === "delivered"`
  - workflow richiesto `ready` o `delivered`
  - attivo solo se `RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY` e' disabilitato
- La risposta resta `200` e include:
  - `idempotent: true`
  - `noop: true`
  - `order` corrente senza bump di revisione
- Il percorso relazionale con CAS resta invariato: se il write primary relazionale e' attivo, la sync passa ancora da `syncRelationalOrderPrimary()` e puo' produrre `409 REVISION_CONFLICT`.

## Test

Comandi eseguiti con Node locale:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/orders/order-lane-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs
```

Risultato:

- `route-policy-architecture`: 42/42 pass
- `orders-flow` + `relational-orders-sync-write-primary`: 7/7 pass
- `server.js`: 38.798 righe, margine M5 702 righe

Nuovo test coperto:

- `[BE][P3] sync terminale duplicata resta idempotente senza side effect`
- Verifica che la seconda sync terminale non incrementi revision, audit, notifiche o fulfillment history.

## Load smoke

Run: `phaseP_interinale_p3_terminal_noop_smoke_20`

- 20 palmari API
- 10 postazioni API
- GUI Playwright: 0
- Operazioni per device: 8
- Business ops: 240
- Failure: 0
- Durata: 45 s
- RT fiscale: 0 tentativi

Metriche principali:

- `order.create` p95: 3043 ms
- `order.sync.ready` p95: 2254 ms
- `order.sync.delivered` p95: 3093 ms
- `order.correct` p95: 2988 ms
- `station.heartbeat` p95: 3068 ms

## Load canary medio

Run: `phaseP_interinale_p3_terminal_noop_canary8_50`

- 50 palmari API
- 10 postazioni API
- GUI Playwright: 0
- Operazioni per device: 12
- Business ops: 720
- Failure: 0
- Durata: 93 s
- RT fiscale: 0 tentativi

Metriche principali:

- `order.create` p95: 9957 ms
- `order.sync.ready` p95: 9962 ms
- `order.sync.delivered` p95: 10204 ms
- `order.correct` p95: 9814 ms
- `station.heartbeat` p95: 6697 ms

## Load canary comparabile

Run: `phaseP_interinale_p3_terminal_noop_canary20_50`

- 50 palmari API
- 10 postazioni API
- GUI Playwright: 0
- Operazioni per device: 20
- Business ops: 1200
- Failure: 0
- Durata: 184 s
- RT fiscale: 0 tentativi

Metriche principali:

- `order.create` p95: 16299 ms
- `order.sync.ready` p95: 16539 ms
- `order.sync.delivered` p95: 16002 ms
- `order.correct` p95: 16104 ms
- `order.comp` p95: 13926 ms
- `station.heartbeat` p95: 3871 ms

## Confronto con diagnostica precedente

Baseline diagnostica: `phaseP_interinale_p3_workflow_bucket_canary8_50`

- Business ops: 1200
- Failure: 0
- Durata: 190 s
- `order.create` p95: 14126 ms
- `order.sync.ready` p95: 13961 ms
- `order.sync.delivered` p95: 14463 ms
- `order.correct` p95: 12791 ms
- `order.comp` p95: 12590 ms
- `station.heartbeat` p95: 1633 ms

Il run terminal-noop non dimostra un miglioramento P3 sul carico lungo. La durata totale scende leggermente, ma i p95 ordine peggiorano nel campione comparabile; il mix casuale del load non e' A/B controllato, pero' il dato non basta per accreditarlo come ottimizzazione di latenza.

Diagnostica interna order lane sul canary comparabile:

- `wf=delivered`: 83 sync, wait medio 9761 ms, wait max 17129 ms, run medio 867 ms, run max 2494 ms
- `wf=ready`: 90 sync, wait medio 11583 ms, wait max 16963 ms, run medio 761 ms, run max 2308 ms

Il collo resta l'attesa nella order lane, non la durata media del singolo handler sync.

## Decisione

La patch resta promossa come fix di idempotenza/coerenza:

- evita side effect su sync terminali duplicate reali;
- non rompe il CAS relazionale;
- passa smoke, canary e test mirati.

Non viene conteggiata come miglioramento prestazionale principale della P3. Il prossimo passo deve attaccare la coda order lane sui burst lunghi, con priorita' su:

1. separare o limitare la pressione tra create/sync/correct/comp;
2. misurare hit rate di sync duplicate terminali con un contatore esplicito;
3. valutare batching/parallelismo controllato solo dove non rompe ordering e CAS.

