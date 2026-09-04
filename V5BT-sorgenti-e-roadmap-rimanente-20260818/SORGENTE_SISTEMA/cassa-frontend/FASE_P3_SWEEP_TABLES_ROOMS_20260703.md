# Fase P3 interinale - Sweep Tavoli/Sale

Data: 2026-07-03

## Contesto

Questo step segue `ROADMAP_INTERINALE_P3_LATENZA.md`, da eseguire prima di
riprendere la roadmap v5 da P4. L'obiettivo immediato era chiudere il gap del
dominio Tavoli/Sale, rimasto non sweeped dopo reservation e payments, con
`ORDER_SYNC_FAST_LANE_CONCURRENCY=8`.

## Diagnosi

Il primo outlier non era un costo interno dei soli handler sala/tavolo: due
route Tavoli/Sale erano presenti sia nella room lane sia nella notification
lane:

- `/api/pos/room-change/request`
- `/api/integration/layout/table/room-move/request`

Poiche' il dispatcher valutava prima la notification lane, le richieste venivano
catturate dalla coda sbagliata e finivano dietro traffico non pertinente. Il
sintomo era `table.room_move.request` con p95 nell'ordine di decine di secondi.

Durante i run successivi sono emersi anche due outlier laterali:

- `waiter.pause.start/stop`, prima accodati nella notification lane;
- `station.heartbeat`, prima bloccato dalla sola presenza di traffico order lane.

Non sono Tavoli/Sale in senso stretto, ma falsavano la misura del canary a 8.

## Modifiche

- Rimossi i due request path Tavoli/Sale da `NOTIFICATION_LANE_PATHS`; restano
  instradati nella room lane.
- Aggiunta `waiterPauseLane` dedicata per `waiter.pause.start/stop`, con metriche
  runtime proprie (`waiterPauseLaneEnqueued`, depth/running, wait/run by label).
- `stationStateLane` non resta piu' ferma solo perche' la order lane sta
  lavorando: continua a rispettare la pressione da payment/room/reservation.
- `rooms.tableRoomMove.request.appStateWrite` e' stato ridotto:
  - sync notifiche puntuale quando l'ID e' noto;
  - sync `waiterDeferredCalls` solo quando cambia;
  - write principale limitato a `posTableRoomMoveRequests`.

`server.js` resta dentro il gate M5: 38.798 righe su limite 39.500.

## Verifica tecnica

Comandi eseguiti:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/modules/runtime-metrics.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito: 46/46 test pass.

Guardrail aggiunti/confermati:

- i request path Tavoli/Sale non devono rientrare nella notification lane;
- `stationStateLane` non deve contenere `orderSyncLaneRunning > 0` nel peer block;
- `tableRoomMove request` sincronizza notifiche puntuali senza riscrivere tutto
  `integration`;
- `waiterPauseLane` e' visibile nelle metriche runtime;
- `mysql-audit-events-split.repository.js` e' agganciato e coperto dal test
  `mysql audit split batches explicit audit upserts`.

## Canary 8 worker

### Run pulito 1

Run: `phaseP_interinale_p1_table_scope_final_50`

- durata: 230,2 s
- business ops: 1260
- HTTP: 3084
- failure: 0
- fiscale virtuale: 5/5
- retry/deadlock app-state: 0
- `table.room_move.request`: count 40, p50 804 ms, p95 4049 ms, p99 4067 ms, max 4797 ms
- `room.change.request`: count 26, p50 1518 ms, p95 3995 ms, p99 4112 ms, max 5589 ms
- `rooms.tableRoomMove.request.appStateWrite`: count 24, avg 64 ms, p95 <=250 ms, max 148 ms
- `station.heartbeat`: p95 7854 ms, p99 16599 ms
- `waiter.pause.start`: p95 7307 ms
- `waiter.pause.stop`: p95 5857 ms

### Run pulito Tavoli/Sale 2

Run: `phaseP_interinale_p1_table_scope_final2_50`

- durata: 205,5 s
- business ops: 1260
- HTTP: 2938
- failure: 0
- fiscale virtuale: 5/5
- `table.room_move.request`: count 44, p50 1265 ms, p95 3537 ms, p99 3728 ms, max 3818 ms
- `room.change.request`: count 28, p50 1382 ms, p95 2752 ms, p99 3471 ms, max 3492 ms
- `rooms.tableRoomMove.request.appStateWrite`: count 27, avg 86 ms, p95 <=250 ms, max 692 ms
- `station.heartbeat`: p95 14089 ms, p99 17274 ms
- `waiter.pause.start`: p95 15808 ms
- `waiter.pause.stop`: p95 9920 ms

Nel secondo run e' presente 1 retry transient, ma non sul dominio Tavoli/Sale:

- `appStateWriteHook:waiter.pause.stop.appStateWrite.beforeWrite.failure.transientDbError`
- `appStateWriteRetry:waiter.pause.stop.appStateWrite.stage.beforeWrite.transientDbError`

Quindi il DoD del Passo 1 e' soddisfatto: due run consecutivi a concorrenza 8
senza retry/deadlock sul dominio Tavoli/Sale.

## Stato roadmap interinale

- Passo 1, Sweep Tavoli/Sale: completato.
- Passo 2, audit events split: completato, file agganciato e testato.
- Passo 3, isolamento outlier: avviato. Sono stati isolati outlier non-order
  (`waiter.pause`, `station.heartbeat`), ma resta da isolare la coda lunga della
  order lane.
- Passo 4, canary concorrenza 8: eseguito per Tavoli/Sale; non ancora valido
  come gate finale globale perche' rimane un retry su `waiter.pause.stop` nel
  secondo run.
- Passo 5, capacita': calcolo preliminare documentato sotto, da rifare dopo il
  fix della coda order lane.

## Capacita' preliminare

Run 1:

- arrivo osservato: 1260 business ops / 230,2 s = 5,47 ops/s
- HTTP osservato: 3084 / 230,2 s = 13,40 req/s

Run 2:

- arrivo osservato: 1260 business ops / 205,5 s = 6,13 ops/s
- HTTP osservato: 2938 / 205,5 s = 14,29 req/s

Questo basta per lo sweep Tavoli/Sale, ma non chiude il gate P3: `order.create`
resta intorno a p95 18 s nei due run. Il prossimo step deve quindi restare sul
Passo 3 della roadmap interinale: correlare la coda p95 order lane con
dimensione ordine, numero righe, correzioni e audit collegati, poi separare le
operazioni pesanti o ridurne il costo.

## Artefatti

- `logs/loadtest-phaseP_interinale_p1_table_scope_final_50/report.json`
- `logs/loadtest-phaseP_interinale_p1_table_scope_final_50/backend.log`
- `logs/loadtest-phaseP_interinale_p1_table_scope_final2_50/report.json`
- `logs/loadtest-phaseP_interinale_p1_table_scope_final2_50/backend.log`
