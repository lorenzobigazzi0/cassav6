# Fase P3 - Piano storno multiprocesso

Data: 2026-07-06

## Stato di partenza

Il percorso multi-processo ordini e' a 12/13 route attive pronte per `api-worker`.
La sola route residua e':

```text
POST /api/integration/orders/storno
```

Lo stato live MP-4bi usa gia' owner `5281`, realtime-gateway `5282`, api-worker `5283`
e frontend HTTPS `5280`. La allowlist corrente arriva fino a `transfer/force`.

`storno` ha gia':

- flag write-primary dedicato `BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY`;
- lettura preferenziale dal read-model relazionale quando il flag e' attivo;
- CAS su `expectedRevision/currentRevision/revision`;
- persistenza ordine primaria prima del mirror app-state;
- test `relational-orders-storno-write-primary.e2e.test.mjs`;
- controllo architetturale `MP-4bd orders/storno usa write-primary relazionale dedicato con CAS`.

Audit corrente:

```text
readyForOrderWorker=13
blockedForOrderWorker=0
```

## Perche' storno non e' una route semplice

Il handler e' condiviso con `comp`, ma `POST /api/integration/orders/storno` non si limita
a cambiare l'ordine. Nel percorso non-zero-cost:

- calcola copertura e piano rimborso partendo da `paymentContainers`;
- puo' marcare un pagamento POS originale come superseded;
- puo' creare nuovi `paymentContainers`, `paymentParts`, `paymentTransactions` per il riaddebito POS;
- aggiorna campi economici dell'ordine (`total`, `paidAmount`, `dueAmount`, `compedAmount`);
- genera `orderComps`;
- puo' generare print job `payment_storno`;
- ricalcola `table_states`/bills via financial sync;
- deve restare coerente con lo split app-state `paymentsFiscal` e con il read model relazionale pagamenti.

Quindi non basta aggiungere la route alla allowlist: bisogna rendere deterministico e
idempotente il blocco economico/fiscale prima di consentire esecuzione parallela su worker.

## Decisione di implementazione

Per l'ultimo step P3 si procede con write-primary coordinato anche per i side effect
pagamenti/fiscale dello storno, lasciando il default OFF e rollback a una variabile.

Flag proposti:

```text
BACKEND_RELATIONAL_ORDERS_STORNO_PAYMENT_EFFECTS_WRITE_PRIMARY=1
BACKEND_RELATIONAL_ORDERS_STORNO_EVENT_OUTBOX=1
BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1
CANARY_REQUIRE_STORNO=1
CANARY_EXPECT_STORNO_PROXY_ROLE=api-worker
```

Il preset finale deve abilitare esplicitamente `POST /api/integration/orders/storno`
solo dopo audit GO.

## Step 1 - Test di contratto prima del runtime

Stato 2026-07-06: COMPLETATO.

Aggiungere un e2e dedicato, senza stampa reale:

```text
cassa-frontend/backend/tests/relational-orders-storno-payment-effects.e2e.test.mjs
```

Copertura minima:

- ordine consegnato e pagato in contanti;
- storno parziale o totale con `PRINTING_ENABLED=0`;
- ordine relazionale aggiornato con CAS;
- `orderComps` contiene record storno idempotente;
- `table_states` relazionale aggiornato con guard di revisione;
- `paymentContainers/paymentParts/paymentTransactions` coerenti e non duplicati su retry;
- print job `payment_storno` accodato una sola volta se previsto;
- retry con stessa `idempotencyKey` non duplica side effect;
- conflitto `expectedRevision` ritorna 409 e non scrive ne' ordine, ne' pagamenti, ne' print job.

Per POS va aggiunto un secondo caso:

- pagamento POS originale superseded una sola volta;
- eventuale riaddebito residuo creato una sola volta;
- nessun documento fiscale reale chiamato nel test;
- fiscal/payment refs conservati nel `refundPlan`.

Esito: aggiunto `relational-orders-storno-payment-effects.e2e.test.mjs` con
copertura cash pagato, POS parziale con supersede/riaddebito e stale conflict 409.
Il test ha trovato un bug reale: dopo un incasso, lo storno write-primary leggeva
dal relazionale un ordine economicamente stale e calcolava lo storno come non pagato.
Fix applicato: i write-primary pagamenti tavolo/free-split sincronizzano nella stessa
transazione relazionale anche lo stato economico degli ordini toccati, con CAS sulla
revisione ordine e aggiornamento dell'app-state alla revisione risultante.

## Step 2 - Rendere atomici i side effect pagamento

Stato 2026-07-06: COMPLETATO come estrazione owner-only, senza ingresso in
allowlist worker.

Estrarre dal monolite la parte oggi interna a:

```text
resolveOrderCompPaymentReferences
buildOrderCompRefundPlan
buildPaymentReferencesFromRefundPlan
applyOrderCompPaymentAdjustmentsForRefundPlan
appendPaymentStornoPrintJobToDb
```

Modulo candidato:

```text
cassa-frontend/backend/modules/integration/order-storno-payment-effects.js
```

Contratto:

- input puro: snapshot ordine, snapshot pagamenti, impostazioni, utente/sessione, compId;
- output: `paymentAdjustment`, `paymentMutations`, `printPayloads`, `paymentReferences`, `refundPlan`;
- nessuna lettura implicita da `dbCache`;
- nessuna chiamata diretta a stampante o fiscale;
- idempotenza basata su `compId` e `idempotencyKey`.

Nel primo passaggio il modulo puo' ancora applicare patch su `db`, ma deve restituire anche
un diff verificabile dai test. Il passaggio finale deve persistere su relazionale prima del
mirror app-state quando il flag write-primary side-effect e' attivo.

Esito: creato `cassa-frontend/backend/modules/integration/order-storno-payment-effects.js`
con factory a dipendenze esplicite. Il server resta orchestratore e usa il modulo per:

- copertura pagamento dello storno;
- piano refund;
- refs pagamento/fiscale;
- mutazioni POS full-void + riaddebito residuo;
- payload/append print job `payment_storno`.

Il risultato delle mutazioni pagamento contiene anche `mutationSummary` con ids
superseded/creati, utile per test e audit successivi. `server.js` scende a 38.047 righe,
lasciando margine al gate M5.

## Step 3 - Financial sync da fonte relazionale

Stato 2026-07-06: COMPLETATO.

Il pattern e' quello gia' usato per cancel/comp/correct/price-override:

```text
listRelationalOrderWorkflowSnapshot
buildOrderFinancialSyncState
captureRelationalOrderFinancialTableGuard
syncPosTableFinancialsFromIntegrationOrders
applyOrderFinancialTableRevisionTokens
persistRelationalOrderFinancialTables
```

Per `storno` il gate deve essere piu' severo:

- lo snapshot ordini relazionale deve includere `nextOrder`;
- la guard `table_state` va catturata prima del ricalcolo;
- il persist `table_states` deve fallire in modo visibile se la revisione non corrisponde;
- su fallimento non bisogna confermare lo storno al client.

Se il sistema non ha ancora una transazione relazionale unica ordine+pagamenti+table_state, il
gate worker deve restare NO-GO. Il piano accetta una fase intermedia con owner-only e test verdi,
ma non l'ingresso in allowlist.

Esito: lo storno ora usa la stessa catena relazionale gia' validata per `comp`, ma con
metriche dedicate `orders.storno.relationalFinancialSnapshotRead` e
`orders.storno.appStateWrite`. L'audit riconosce lo snapshot ordini relazionale e la
guardia `table_state` come esternalizzati per `orders/storno`, quindi il blocker
`financial-sync` e' rimosso. La route resta fuori allowlist finche' `fiscal-payments`
non viene modellato come intent persistente condiviso.

## Step 4 - Fiscale e print spool

Stato 2026-07-06: COMPLETATO come intent persistente condiviso, senza usare
stampa o fiscale reali nei test.

Regola: nessuna emissione fiscale reale nel canary.

Per lo storno worker-ready:

- `payment_storno` deve essere un print job persistito e idempotente, non un effetto immediato;
- il worker stampa/fiscale resta solo sull'owner (`SHOULD_RUN_BACKEND_OWNER_JOBS`);
- eventuali richieste POS/fiscali devono essere modellate come record/intent persistenti;
- l'api-worker puo' creare l'intent, ma non deve eseguire job owner;
- il canary deve girare con `PRINTING_ENABLED=0` oppure stampanti/fiscale virtuali.

Esito: aggiunta write dedicata `writeOrderStornoFiscalPaymentIntentDb` con metric label
`orders.storno.fiscalPaymentIntentWrite`. La write persiste i domini condivisi
`payments`, `paymentContainers`, `paymentParts`, `paymentTransactions`,
`paymentProviderTransactions`, `fiscalReceipts`, `fiscalEvents`, `printSpoolJobs` e
`auditEvents` prima del mirror app-state dello storno. Il test architetturale MP-4bm
vincola l'ordine `fiscalPaymentIntentWrite -> writeIntegrationOrderSyncDb`, mentre
l'e2e MP-4bj continua a coprire cash, POS parziale con supersede/riaddebito e stale 409
senza duplicare side effect.

## Step 5 - Audit route e route-policy

Stato 2026-07-06: COMPLETATO per il gate statico/audit; resta da aggiungere il preset
canary finale dello Step 6.

Solo dopo i test sopra:

- aggiornare `order-workflow-externalization-audit.mjs`;
- rimuovere da storno il blocker `financial-sync` dopo Step 3;
- rimuovere da storno il blocker `fiscal-payments` solo dopo Step 4;
- aggiungere test metadata per i nuovi e2e;
- portare `readyForOrderWorker` da 12 a 13;
- aggiornare `order-workflow-externalization-audit.test.mjs`;
- aggiungere route-policy test dedicato, per verificare che:
  - side effect pagamenti/fiscale siano persistiti come intent condivisi prima del mirror app-state;
  - non ci siano chiamate fiscali/stampa immediate nel percorso api-worker;
  - lo storno usi snapshot finanziario relazionale;
  - lo storno non dipenda da owner-local state non esternalizzato.

Esito: `order-workflow-externalization-audit --no-write` restituisce
`orderWorkersGoNoGo=go`, `readyForOrderWorker=13`, `blockedForOrderWorker=0` e
`blockerDimensionSummary=[]`. `POST /api/integration/orders/correct/resolve` resta
disabilitata e fuori dal conteggio attivo.

## Step 6 - Canary e preset finale

Stato 2026-07-06: LIVE CANARY COMPLETATO. Preset, preflight, route-canary ed e2e
sono pronti e validati in live con `PRINTING_ENABLED=0`.

Aggiornare `order-worker-sync-e2e-canary.mjs`:

- `CANARY_REQUIRE_STORNO=1`;
- `CANARY_EXPECT_STORNO_PROXY_ROLE`;
- funzione `stornoOrder(...)` analoga a `compOrder(...)`;
- stage dopo readback e prima del cleanup;
- output report: status, proxy role, order id, revision, total/due, comp id, storno print job;
- gate finale `stornoGateOk`.

Aggiornare `phase-p-validation-preflight.mjs`:

- route canary `order-worker-storno-allowlist`;
- e2e `order-worker-create-storno-sync-e2e` o `order-worker-full-13-sync-e2e`;
- audit allowlist a 13 route.

Aggiornare `tools/restart-cassav4-linux.sh`:

- preset finale con suffisso `_STORNO_CANARY`;
- allowlist finale con tutte le 13 route attive:

```text
POST /api/integration/orders/create
POST /api/integration/orders/sync
POST /api/integration/orders/cancel
POST /api/integration/orders/comp
POST /api/integration/orders/correct
POST /api/integration/orders/replacement/bar-charge
POST /api/orders/replacement/bar-charge
POST /api/integration/orders/line/split
POST /api/integration/orders/transfer/resolve
POST /api/integration/orders/transfer/request
POST /api/integration/orders/line/price-override
POST /api/integration/orders/transfer/force
POST /api/integration/orders/storno
```

Control route per il route-canary finale: usare una mutazione owner-only non order-workflow,
per esempio una route fiscal/payment non allowlistata. Non usare `correct/resolve`, perche'
e' disabled 410 e non rappresenta piu' bene il controllo.

Esito supporto: aggiunto preset
`BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1`
con allowlist a 13 route. Il route-canary finale usa `POST /api/integration/orders/storno`
come target e `POST /api/payments/table` come controllo owner-only. L'e2e finale usa
`CANARY_REQUIRE_STORNO=1`, consegna l'ordine, paga cash con stampa disabilitata e poi verifica
lo storno su `api-worker` con `CANARY_EXPECT_STORNO_PROXY_ROLE=api-worker`.

Esito live: il primo e2e ha scoperto il bordo reale `payments/free-split` owner contro ordine
creato dal worker (`Comanda non trovata`). Il modulo pagamenti ora idrata l'ordine esplicito
dal read-model relazionale quando la cache owner non lo contiene, prima dei calcoli
`authoritativePayment` e financial table. Secondo e2e verde: pagamento pre-storno cash su
`/api/payments/free-split` via owner, storno su `api-worker`, gate tutti `yes`.

## Gate GO/NO-GO

GO solo se:

- audit globale `readyForOrderWorker=13`, `blockedForOrderWorker=0`;
- audit allowlist 13 route `goNoGo=go`;
- route canary: storno passa da proxy a `api-worker`, control resta owner/direct blocked;
- e2e con `CANARY_REQUIRE_STORNO=1` verde;
- retry idempotente non duplica `orderComps`, pagamenti o print job;
- 409 stale non produce side effect;
- health 5280/5281/5282/5283 resta 200;
- `server.js` resta sotto 39.500 righe;
- stampa e fiscale reali non vengono usati durante i canary.

NO-GO se uno di questi resta vero:

- side effect pagamenti derivano solo da `dbCache` locale;
- `paymentContainers` o `paymentTransactions` possono duplicarsi su retry;
- `table_states` non usa guard revision;
- un api-worker puo' eseguire direttamente job stampa/fiscale;
- lo storno pagato POS puo' creare stato parziale non riconciliabile.

## Rollback

Rollback operativo:

```text
BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=0
```

In rollback `storno` resta sull'owner e la allowlist ritorna alle 12 route MP-4bi.

Rollback codice:

- mantenere compatibile il handler condiviso `comp/storno`;
- tenere default OFF tutti i flag nuovi;
- non cambiare la semantica di `comp` e replacement a costo zero;
- non cambiare i flussi pagamento esistenti fuori dal percorso storno.

## Prossimo intervento consigliato

Consolidare il profilo a 13 route con test di carico canary, mantenendo stampa/fiscale virtuali:

1. eseguire load/canary 50 device sul preset `_STORNO_CANARY`;
2. misurare route mix ordini+pagamenti e verificare che i pagamenti owner vedano sempre gli ordini worker dal relazionale;
3. solo dopo esito verde valutare aumento progressivo a 100 device.

## MP-4bp - consolidamento sessioni sotto carico

Stato 2026-07-06: il primo ramp di carico sul profilo finale a 13 route ha
confermato che la route storno resta correttamente su `api-worker`, ma ha
scoperto un bug diverso dal routing: alcune sessioni valide venivano cancellate
da sync split concorrenti, causando `401 Sessione login non valida o scaduta`
durante create/sync.

Causa:

- `mysql-sessions-split.repository.syncFromAppState(...)` faceva replace globale
  del dominio sessioni anche durante login concorrenti;
- `device-status-split.repository.syncFromAppState(...)` sincronizzava anche le
  sessioni quando il write era solo `integration`/station state, quindi snapshot
  locali stale potevano cancellare sessioni create da altri device;
- il canary riportava `createRoutedAsExpected=false` in alcuni fallimenti
  parziali perche' il flag veniva valorizzato solo dopo gli stage successivi.

Fix applicati:

- login app-state write con `sessionsSync: { deleteMissing: false }`;
- device-status split con sync sessioni additivo e supporto
  `sessionsSync.skip` per i write `integration`-only;
- `server.js` passa le opzioni split corrette e non fa piu' toccare sessioni a
  sync station/order-only;
- il canary e2e valorizza subito `createRoutedAsExpected` e
  `createRoutedToOwner` appena la create termina.

Evidenze:

- test split sessioni: `mysql-sessions-split.repository.test.mjs` verde;
- test device-status split: `device-status-split.repository.test.mjs` verde;
- regressione auth-session: `auth-session.e2e.test.mjs` verde dopo il primo fix
  sessioni;
- batch rosso prima del fix finale:
  `logs/mp4bp_load10_sessionfix_tables2_20260706T112823` e
  `logs/mp4bp_load5_devicestatusfix_20260706T113431`;
- batch verde dopo il fix finale:
  `logs/mp4bp_load5_sessionskipfix_20260706T113901`, 5/5 device passati,
  zero `401`, create/lineSplit/priceOverride/transferRequest/
  transferResolve/transferForce/sync/storno su `api-worker`, pagamento su
  owner come previsto.

Gate aggiornato:

- coerenza sessioni sotto concorrenza: GO provvisorio su batch 5;
- gate P3 prestazionale: ancora NO-GO. Le latenze nel batch 5 restano alte
  (create nell'ordine di 12-19s, split 14-25s, alcuni transfer fino a circa
  40s), quindi il load-50 non va dichiarato verde finche' non si riduce CPU/
  accodamento per route o non si scala il worker pool in modo controllato.

Prossimo passo tecnico: ramp progressivo 10 -> 25 -> 50 device solo per
confermare che il bug sessioni non ricompare, poi aprire la fase di capacity
vera sui costi sincroni delle route order workflow.

## MP-4bq - auth/session e transfer lane post-smoke

Aggiornamento successivo: il ramp da 10 device con tavoli distinti ha confermato
che i `401` non erano causati dalla route storno, ma da due colli separati:

- le transfer route (`transfer/request`, `transfer/resolve`, `transfer/force`)
  erano allowlistate su `api-worker` ma non entravano in
  `ORDER_WORKFLOW_FAST_LANE_PATHS`, quindi passavano dalla coda mutativa globale;
- il login postazione poteva leggere uno snapshot senza tutte le sessioni
  esterne e lasciare fuori una sessione `postazione` dal mirror MySQL.

Fix applicati:

- aggiunte `replacement/bar-charge` e le tre transfer route alla order lane;
- `orders/sync` riusa il contesto gia autenticato dalla route policy invece di
  rivalidare sul cache fast-lane;
- il pre-lane terminal duplicate forza `refreshExternalizedSessions:true`;
- il login legge con `refreshExternalizedSessions:true` e scrive
  `splitDomains: ["sessions", "users", "auditEvents"]` con
  `sessionsSync: { deleteMissing:false }`.

Evidenza: smoke live
`logs/mp4bp_load5_loginrefresh_20260706T123923` completata 5/5, zero `401`,
create/lineSplit/transferRequest/transferResolve/transferForce/priceOverride/
sync/storno su `api-worker`; query MySQL confermata con 5/5 sessioni
`postazione` presenti in `app_state_sessions`.

Gate capacity resta NO-GO: il worker unico resta vicino al 100% CPU e le
singole route order workflow possono durare 15-26s sotto batch da 5. Il prossimo
step deve quindi profilare/abbattere CPU per handler o introdurre worker pool
controllato; non e' piu' un problema di sessioni o route allowlist.
