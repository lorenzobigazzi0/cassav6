# Stato avanzamento Sistema Cassa V4

Data salvataggio: 2026-07-03

## Sorgente salvata

Ramo operativo:

`estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`

Roadmap in corso:

`/home/sentrapa/Downloads/CASSAv4_ROADMAP_v5_FASE_P/ROADMAP_REALTIME_CASSAV4_v5_FASE_P.md`

## Avanzamento

Avanzamento stimato sulla roadmap v5 Fase P: circa 96%.

Fasi completate nel filone recente:

- K-PRE completata.
- K completata.
- L completata.
- M1 completata.
- M2 completata.
- M3 completata.
- M4 completata.
- M5 completata.
- M6 completata.
- N1 completata.
- N2 completata.
- N3 completata.
- O completata.
- P0 completata.
- P1 completata.
- P2 completata.

Fase corrente salvata:

- P3 - Scala virtuale `load-50` in hardening, non ancora completata.

Prossimo step previsto:

- Continuare P3: eseguire un secondo `load-50` consecutivo post-fix per
  confermare zero retry app-state, poi aprire il prossimo collo sulla latenza
  `orderLane` (`orders/create` e `orders/sync` restano sopra il gate p95).

Step ancora da completare nella roadmap v5:

- P - Validazione finale, endurance, go/no-go

## Ultima verifica completa

Ultimo full gate backend eseguito dopo M4:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato:

- 991/991 test passati
- 0 falliti
- durata `duration_ms=803962.671627`, circa 13m24s

Verifiche aggiuntive M4:

- `node --check backend/server.js`: ok
- `node --check ../monitor-frontend/dist/app.js`: ok
- test mirati M4: 30/30 pass

Verifiche aggiuntive M5:

- `node --check cassa-frontend/backend/server.js`: ok
- test mirati M5: 18/18 pass
- budget `backend/server.js` abbassato a 39.500 righe; conteggio corrente 38.695 righe con `wc -l`

Verifiche aggiuntive M6:

- `node --check cassa-frontend/backend/server.js`: ok
- `node --check cassa-frontend/backend/modules/print-spool/retention.js`: ok
- test mirati retention/runtime/budget: 10/10 pass
- guardrail route-policy/architettura: 17/17 pass
- default `PRINT_SPOOL_MAX_JOBS` portato a 1.200; orfani `.print-spool` a 12h

Verifiche aggiuntive N1:

- `node --check` server, payment-state-machine, payments.domain, payments.handlers: ok
- test mirati state machine/provider/fiscal boundary/architettura/budget: 38/38 pass
- e2e pagamenti/fiscale/write-primary: 39/39 pass
- flag `PAYMENT_STATE_MACHINE_ENABLED=0` disponibile per rollback canary

Verifiche aggiuntive N2:

- `node --check` server, order-state-machine, order-state-machine.test,
  route-policy-architecture: ok
- test mirati ordine/invarianti/architettura/budget: 59/59 pass
- write-primary ordini create/sync/cancel/correct/comp/events: 6/6 pass
- flag `ORDER_STATE_MACHINE_ENABLED=0` disponibile per rollback canary

Verifiche aggiuntive N3:

- `node --check` server, print-state-machine, print-state-machine.test,
  route-policy-architecture: ok
- test mirati state machine/spool/fiscale/architettura/budget: 45/45 pass
- test layout/ricevute/fiscale: 55/55 pass
- flag `PRINT_STATE_MACHINE_ENABLED=0` disponibile per rollback canary
- budget `backend/server.js`: 38.773 righe su 39.500

Verifiche aggiuntive O:

- `ROADMAP_ARCHITETTURA_v4.1.0.md` riconciliata con
  `ROADMAP_REALTIME_CASSAV4_v4.md`
- aggiunta `docs/architecture/ADR-0002-modular-monolith-revision-20260703.md`
- aggiunto test statico `architecture-roadmap-reconciliation.test.mjs`
- `node --check` del test statico: ok
- test documentali/architetturali/budget: 23/23 pass

Verifiche aggiuntive P0:

- `loadtest-full-capacity.mjs` ora usa `process.execPath` come `NODE_BIN`
  default
- aggiunto `scripts/phase-p-validation-preflight.mjs`
- aggiunto script npm `preflight:phase-p`
- aggiunto test `phase-p-validation-preflight.test.mjs`
- preflight generato in
  `cassa-frontend/logs/phase-p-preflight-20260703075754/REPORT.md`
- `node --check` preflight/loadtest/test: ok
- test P0 + guardrail architetturali: 25/25 pass

Verifiche aggiuntive P1:

- `loadtest-full-capacity.mjs` corretto per usare un device fiscal-enabled nei
  campioni fiscali
- aggiunte metriche provider mock fiscale `/metrics` nel report load test
- retry controllato per pagamento con 428 da lock tavolo perso sotto concorrenza
- `node --check cassa-frontend/scripts/loadtest-full-capacity.mjs`: ok
- smoke finale `phaseP_load-10-p1-final`: 630 operazioni business, 1219
  richieste HTTP, 0 anomalie, code finali 0/0
- fiscale mock: 5 tentativi, 4 successi HTTP 2xx, 4 `receiptRequests` reali

Verifiche aggiuntive P2:

- aggiunto retry backend per deadlock/lock wait MySQL transient sulla route
  `POST /api/integration/stations/state`, prima di esporre HTTP 500
- aggiunto modulo `modules/integration/station-state-transient-retry.js`
  con guardrail statico in `route-policy-architecture.test.mjs`
- il load test ora rilascia il lock tavolo corretto e salta come conflitto
  recuperabile pagamenti/correzioni/storni se l'ordine viene spostato durante
  l'operazione
- frequenza del keeper presenza postazioni portata a 5s
- `node --check` server, modulo retry, loadtest e test route-policy: ok
- test mirati P2/guardrail: 58/58 pass
- run finale `phaseP_load-25-p2-fixed`: 1850 operazioni business, 4552
  richieste HTTP, 0 anomalie, code finali 0/0
- fiscale mock: 4 tentativi, 4 successi HTTP 2xx, 7 `receiptRequests` provider
- nota residua per P3: `table.move` resta coerente ma con p95 194720 ms e max
  261886 ms sotto pressione della room-lane

Verifiche aggiuntive P3 diagnostica:

- P3 `load-50` avviata con 50 palmari, 10 postazioni, 3 GUI, 70 operazioni per
  device e mock fiscal/printer
- tre tentativi interrotti per saturazione persistente `order-lane`:
  `phaseP_load-50-p3`, `phaseP_load-50-p3-fixed`,
  `phaseP_load-50-p3-refill`
- corretta priorita' room-lane con `ROOM_LANE_PRESSURE_PRIORITY_DEPTH`
- `ORDER_SYNC_FAST_LANE_CONCURRENCY` portata a default 6, cap 8
- `orders/create` riportato a priorita' live nella order-lane; station
  reconciliation spostata dietro
- order-lane resa capace di ricaricare slot liberi mentre altri worker della
  stessa lane sono ancora attivi
- `node --check` server/test: ok
- test mirati P3/guardrail: 27/27 pass
- P3 non marcata completata: anche dopo i fix la coda order-lane resta circa
  50-60 sotto `load-50`, con attese medie oltre 30s

Verifiche aggiuntive P3 metriche workflow ordini:

- aggiunte runtime metrics `operations.runMsByLabel`
- aggiunto dettaglio `appState.writeRunMsByLabel`
- etichettata la create ordine come `orders.create.appStateWrite`
- strumentati `orders.create.relationalWrite`,
  `orders.sync.relationalWrite`, `orders.events.relationalAppend` e
  `orders.sync.appStateWrite`
- report loadtest/endurance aggiornati con tabelle app-state write per label e
  operations
- `node --check` moduli metriche/app-state/ordini/server/script loadtest: ok
- test mirati repository/metriche/P/guardrail/budget: 62/62 pass

Verifiche aggiuntive P3 fast path notifiche/posSettings:

- `POST /api/mobile/waiter-pause/status` reso davvero read-only: non scrive DB
  e non entra piu' in `notification-lane`
- aggiunto calcolo read-only della pausa scaduta senza mutare il record
- `posSettings` configurato nel domain split MySQL come `object-entry`;
  `posSettings.tables` configurato come array annidato a entry
- `writeIntegrationOrderSyncDb` aggiorna solo i tavoli finanziariamente cambiati
  via `posSettingsTableIds`, con fallback full sync se gli ID non sono
  disponibili
- test mirati pausa/runtime/guardrail/budget/write-primary ordini: 42/42 pass
- snapshot load ridotti:
  `logs/loadtest-phaseP_load-50-p3-waiterstatus/runtime-metrics-midrun.json`
  e
  `logs/loadtest-phaseP_load-50-p3-possettings-tables/runtime-metrics-midrun.json`
- miglioramento osservato: `orders/create` run medio da 1013.76 ms a 925.03 ms,
  `orders/sync` run medio da 1106.96 ms a 1007.67 ms; P3 resta non completata
  per coda order-lane ancora intorno a 50 elementi sotto burst `load-50`

Verifiche aggiuntive P3 order audit fast path:

- aggiunte metriche per-step `orderWorkflowStep:*` dentro
  `writeIntegrationOrderSyncDb`
- aggiunto `syncEntriesFromAppState(appState, eventIds)` ai repository split
  audit MySQL e SQLite
- `orders/create` e `orders/sync` ora passano al fast path audit solo gli ID
  degli audit creati dalla singola mutazione
- test mirati app-state/runtime/guardrail/budget/write-primary ordini: 68/68
  pass
- snapshot load ridotti:
  `logs/loadtest-phaseP_load-50-p3-ordersteps/runtime-metrics-midrun.json`
  e
  `logs/loadtest-phaseP_load-50-p3-auditids/runtime-metrics-midrun.json`
- miglioramento osservato: `orders.create.auditRecent` medio da 647.95 ms a
  173.95 ms, `orders.sync.auditRecent` medio da 449.27 ms a 94.33 ms;
  `orders.create.appStateWrite` medio da 1133.61 ms a 556.61 ms
- P3 resta non completata: prossimo collo misurato
  `orders.sync.mysql.notifications` medio 550.67 ms

Verifiche aggiuntive P3 order notifications fast path:

- aggiunto `syncOrderNotificationsFastPath` per sincronizzare
  `integration.notifications` per ID esplicito quando `orders/sync` crea una
  nuova notifica `order_ready`
- `orders/sync` passa `notificationIds` solo per notifiche non deduplicate, con
  fallback full sync quando l'ID non e' disponibile
- aggiunto guardrail statico in `route-policy-architecture.test.mjs`
- test mirati app-state/runtime/guardrail/budget/write-primary/notifiche:
  83/83 pass
- snapshot load ridotto:
  `logs/loadtest-phaseP_load-50-p3-notificationids/runtime-metrics-midrun.json`
- miglioramento osservato: `orders.sync.mysql.notifications` medio da
  550.67 ms a 89.17 ms, max 299 ms; P3 resta non completata per pressione
  residua sulla `order-lane`
- prossimo collo misurato:
  `orders.sync.mysql.fulfillmentHistory` medio 361.25 ms,
  `orders.sync.mysql.orders` medio 286.35 ms

Verifiche aggiuntive P3 order fulfillment fast path:

- aggiunto `syncOrderFulfillmentHistoryFastPath` per sincronizzare
  `integration.orderFulfillmentHistory` per ID evento quando `orders/sync`
  registra una comanda pronta/consegnata
- `orders/sync` passa `fulfillmentHistoryIds` con l'ID dell'evento appena
  creato
- mantenuto full sync quando lo storico era gia' al limite
  `INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY`, cosi' vengono rimosse dal domain
  split anche le righe potate
- aggiunto guardrail statico in `route-policy-architecture.test.mjs`
- test mirati app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer: 91/91 pass
- snapshot load ridotto:
  `logs/loadtest-phaseP_load-50-p3-fulfillmentids/runtime-metrics-midrun.json`
- miglioramento osservato: `orders.sync.mysql.fulfillmentHistory` medio da
  361.25 ms a 94.58 ms, max da 992 ms a 216 ms
- prossimo collo misurato:
  `orders.sync.mysql.orders` medio 315.51 ms,
  `orders.create.mysql.orders` medio 200.13 ms

Verifiche aggiuntive P3 order station index fast path:

- reso change-aware il sync puntuale dell'indice `order_station` in
  `mysql-domains-split.repository.js`
- `syncOrderStationIndex` ora confronta le chiavi indice esistenti con quelle
  calcolate e salta delete/insert quando station/match/posizione non cambiano
- il full replace dell'indice resta invariato nei full sync
- aggiunto test repository: cambio totale senza rewrite indice, cambio
  postazione con rewrite indice
- test mirati app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer: 92/92 pass
- snapshot load ridotto:
  `logs/loadtest-phaseP_load-50-p3-orderindex/runtime-metrics-midrun.json`
- miglioramento osservato: `orders.sync.mysql.orders` medio da 315.51 ms a
  293.25 ms; `orders.sync.appStateWrite` medio da 666.69 ms a 644.57 ms
- prossimo collo: resta `orders.sync.mysql.orders`; serve metrica interna del
  repository per separare lettura stato, upsert riga e sync indice

Verifiche aggiuntive P3 domain split internal metrics:

- `mysql-domains-split.repository.js` riceve `runtimeMetrics` dal server
- aggiunte metriche `appStateDomainSplit:*` per `integration.orders.entries`
  e `integration.orders.index`
- metriche entries: `stateRead`, `upsertChangedRows`, `total`
- metriche index: `collect`, `stateRead`, `compare`, `deleteRows`,
  `insertRows`, `total`
- aggiunti test repository e guardrail statico
- test mirati app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer: 93/93 pass
- snapshot load ridotto:
  `logs/loadtest-phaseP_load-50-p3-domainmetrics/runtime-metrics-midrun.json`
- evidenza: `integration.orders.entries.total` medio 244.11 ms; `index.total`
  medio 44.51 ms; `entries.stateRead` medio 22.80 ms;
  `entries.upsertChangedRows` medio 10.79 ms
- prossimo collo: misurare `ensure`, `getConnection`, `beginTransaction`,
  `commit` e rollback; il residuo sembra fuori da stateRead/upsert/index

Verifiche aggiuntive P3 transaction metrics:

- aggiunte metriche `appStateDomainSplit` per `entries.ensure`,
  `entries.getPool`, `entries.getConnection`, `entries.beginTransaction`,
  `entries.commit`, `entries.rollback`, `entries.release`
- `withConnection` misura pool/connection/release solo quando riceve
  `metricPrefix`
- test repository e guardrail statico aggiornati
- test mirati app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer: 93/93 pass
- snapshot load ridotto:
  `logs/loadtest-phaseP_load-50-p3-transactionmetrics/runtime-metrics-midrun.json`
- evidenza: `entries.total` medio 222.79 ms; `entries.commit` medio 52.28 ms;
  `entries.rollback` medio 52.80 ms con 45 campioni; `entries.ensure` medio
  40.13 ms; `entries.getPool` medio 32.43 ms; `entries.upsertChangedRows`
  medio 10.84 ms
- prossimo collo: distinguere rollback da conflitti operativi/transient DB e
  poi ridurre overhead `ensure/getPool` o batching transazionale

Verifiche aggiuntive P3 rollback causes e retry ordini:

- aggiunta classificazione cause per `integration.orders.entries`:
  `error.<cause>`, `rollback.cause.<cause>`, `outcome.committed`,
  `outcome.rolledBack`, `rollback.failed`
- cause normalizzate: `transientDbError`, `revisionConflict`, `duplicate`,
  `unknown`
- aggiunto retry transient MySQL per workflow ordine, limitato alle route della
  order lane e prima della risposta HTTP 500
- aggiunti test repository e guardrail statici
- test mirati app-state/guardrail: 67/67 pass
- test P3 ampia app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer: 95/95 pass
- run pre-fix `logs/loadtest-phaseP_load-50-p3-rollbackcauses/report.json`:
  1260 business ops, 91 anomalie finali, 89 deadlock HTTP 500 su
  `orders/create`
- run post-fix
  `logs/loadtest-phaseP_load-50-p3-rollbackcauses-postfix/report.json`:
  1260 business ops, 0 anomalie finali, 147 retry ordine, code finali
  `dbMutation=0` e `orderLane=0`
- P3 resta non completata: il sistema recupera i deadlock, ma il run passa da
  227s a 338s; serve ridurre la contesa residua invece di limitarci al retry

Verifiche aggiuntive P3 station reconciliation backpressure:

- aggiunte metriche `errorStage.<step>.<cause>` per lo split MySQL degli ordini
- `station-orders-reconciliation` supporta `isBackpressureActive`,
  `backpressureDelayMs` e `deferInitialSchedule`
- il server differisce la riconciliazione da polling postazione quando la
  `order-lane` e' sotto pressione e applica un debounce iniziale
- corretto il pagamento su comanda spostata durante concorrenza:
  `PAYMENT_ORDER_NOT_IN_TABLE` ora risponde 409, conflitto recuperabile, non 400
- test mirati scheduler/app-state/guardrail: 78/78 pass
- test P3 ampia app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer/scheduler: 107/107 pass
- run `logs/loadtest-phaseP_load-50-p3-stationdebounce/report.json`:
  1260 business ops, durata 313s, 145 retry ordine, code finali 0/0
- attese `GET /api/integration/orders station reconciliation` ridotte da circa
  286s a circa 2.2s max nel log backend
- il run ha registrato 1 anomalia `payment.free_split` 400 stale table/order,
  corretta subito dopo a 409; full load non rilanciato dopo questa correzione

Verifiche aggiuntive P3 order station index batch:

- aggiunta protezione runtime metrics per non perdere le label diagnostiche P3
  `errorStage` quando la top list e' piena
- confermato con load `phaseP_load-50-p3-errorstage-pinned` che i rollback
  residui erano nello stage
  `integration.orders.entries.errorStage.orderStationIndex.transientDbError`
- l'indice ordini/postazioni ora salta il `DELETE` vuoto sulle nuove comande e
  inserisce le righe indice in batch ordinato
- aggiornato lo stress test per classificare come skip attesi solo le race
  concorrenti esplicite gia' gestite dal backend su correzioni/storni
- test mirati app-state/runtime/guardrail: 74/74 pass
- test P3 ampia app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer/scheduler: 109/109 pass
- run finale `logs/loadtest-phaseP_load-50-p3-clean-final/report.json`:
  1260 business ops, durata 232s, 0 failure, RT virtuale 4/4, code finali 0/0
- rollback ordini P3 azzerati: 161 -> 0
- insert indice ridotti: 56332 -> 767 campioni, durata totale run -32% circa
- residuo da prossimo step: 2 retry recuperati nella write app-state generale,
  fuori dallo stage `orderStationIndex`

Verifiche aggiuntive roadmap v5 P3.13/P3.14:

- copiata nel progetto tutta la cartella
  `CASSAv4_ROADMAP_v5_FASE_P`, con roadmap e playbook audit domini
- aggiunto breakdown retry app-state per stage/causa:
  `appStateWriteRetry:stage.<stage>.<cause>`
- aggiunte metriche hook pre-write:
  `appStateWriteHook:*`
- runtime metrics ora conserva anche le label
  `appStateWriteRetry` e `appStateWriteHook`
- writer dominio etichettati con metriche stabili per pagamenti, sale,
  prenotazioni e notifiche
- `writeReservationDb` ora rispetta `splitDomains` espliciti; i lock
  reservation scrivono solo `posReservationLocks`
- le route reservation passano domini stretti per create/update/lock/delete e
  includono tavoli/sale solo quando lo status prenotazione cambia davvero il
  layout
- `writeDb` assegna label diagnostica `route:<METHOD path>.appStateWrite`
  quando una scrittura generica resta senza label
- test reservation/app-state/runtime/route-policy: 104/104 pass
- test rapidi post fallback route label: 75/75 pass
- run P3.13 `logs/loadtest-phaseP_v5_p313_breakdown/report.json`:
  1260 business ops, 0 failure, 0 retry app-state, ma order-lane p95 ancora
  26s circa
- probe non promosso `logs/loadtest-phaseP_v5_p314_orderlane8_probe/report.json`:
  1260 business ops, 0 failure, 1 retry app-state su domini reservation;
  concorrenza 8 non promossa
- mini-load post-fix `logs/loadtest-phaseP_v5_p314_route_label_25/report.json`:
  760 business ops, 0 failure, 0 retry app-state
- load-50 post-fix
  `logs/loadtest-phaseP_v5_p314_reservation_scope_50/report.json`:
  1260 business ops, 0 failure, nessun `Deadlock found`, nessun
  `Hook pre-write app-state`, nessun `Write app-state MySQL in retry`
- P3 resta non completata: `orderLane` p95 create/sync ancora circa 22-23s
  sotto load-50

## Report inclusi

Il ramo contiene i report di fase gia' prodotti. Il report piu' recente e':

`cassa-frontend/FASE_P3_V5_RETRY_BREAKDOWN_RESERVATION_SCOPE_20260703.md`

## Note archivio

Lo zip di avanzamento deve conservare codice, test, report e frontend statici
compilati. Sono esclusi solo file runtime o reinstallabili:

- `node_modules`
- `logs`
- `.print-spool`
- `.cache`
- archivi zip/tar interni
- file temporanei
