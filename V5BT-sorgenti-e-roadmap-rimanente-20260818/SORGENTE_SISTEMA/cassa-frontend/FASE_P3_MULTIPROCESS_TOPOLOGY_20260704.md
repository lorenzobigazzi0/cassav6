# Fase P3 - Avvio percorso multi-processo vero

Data: 2026-07-04

## Obiettivo

Portare il backend verso un multi-processo reale senza creare piu' monoliti concorrenti con `dbCache`,
lane, registri SSE e cache calde divergenti. Il primo intervento non e' ancora il cluster: e' il
contratto di topologia che stabilisce quali route puo' servire ogni ruolo di processo.

## Decisione

Non si avviano piu' worker generici davanti a `backend/server.js` senza filtro route.

Ruoli introdotti:

```text
monolith          comportamento attuale, default
api-owner         processo proprietario, puo' servire tutto
api-worker        processo scalabile per letture e, in futuro, mutazioni ordine esternalizzate
realtime-gateway  processo dedicato a SSE realtime
```

## Implementazione

Nuovo modulo:

```text
cassa-frontend/backend/core/process-topology.js
```

Nuovo canary runtime:

```text
cassa-frontend/scripts/realtime-gateway-canary.mjs
cassa-frontend/scripts/api-worker-read-canary.mjs
npm --prefix cassa-frontend run canary:realtime-gateway
npm --prefix cassa-frontend run canary:api-worker-reads
```

Il canary apre N client SSE sul multiplexer HTTPS, pubblica M notifiche dall'owner, misura
publish-to-first-delivery e publish-to-all-streams, cancella le notifiche sintetiche e verifica che
`event_outbox` resti senza eventi pendenti.

Funzioni principali:

```text
normalizeBackendProcessRole
classifyBackendRouteForProcess
createBackendProcessRouteGuard
buildBackendProcessTopologyReport
canScaleOrderMutationRoutes
canScaleReadRoutes
shouldRunBackendOwnerJobs
```

Aggancio in `backend/server.js`:

```text
BACKEND_PROCESS_ROLE=monolith          nessun cambio di comportamento
BACKEND_PROCESS_ROLE=realtime-gateway  consente solo health/metriche locali e stream SSE
BACKEND_PROCESS_ROLE=api-worker        consente letture; blocca mutazioni non scalabili
```

I processi non-owner (`realtime-gateway`, `api-worker`) disattivano anche i worker owner di startup:

```text
- shadow sync iniziale full-domain
- recovery/worker spool stampa
- ripresa job fiscali pendenti
- scheduler report palmari
- startup reconcile ordini async-ACK
- publisher periodico event_outbox su api-worker
```

Le route bloccate rispondono con:

```text
HTTP 503
code: BACKEND_PROCESS_ROUTE_BLOCKED
```

Questo evita l'errore architetturale piu' pericoloso: far partire due processi backend completi e
lasciare che entrambi mutino stato in memoria.

## Fotografia route

Output di:

```bash
npm --prefix cassa-frontend run report:process-topology
```

Conteggi attuali:

```text
local-control: 2
realtime-stream: 1
read: 50
order-workflow: 14
single-owner-mutation: 108
```

Le 14 route `order-workflow` sono candidate al vero multi-worker, ma solo dopo questi prerequisiti:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKERS=1
BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1
BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1
BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1
```

Il flag `BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1` non va attivato come scorciatoia: deve
segnare che il percorso ordine non dipende piu' da `dbCache` locale per coerenza economica, tavoli,
notifiche e side effect.

## Perche' questo e' il primo passo corretto

Il collo P3 e' CPU-bound sul singolo thread JS, ma il sistema attuale ha ancora una source of truth
in-process. Un cluster generico migliorerebbe forse il throughput apparente, ma introdurrebbe
divergenze: ogni worker avrebbe un proprio `dbCache`, proprie lane, proprie cache e propri client SSE.

Il route guard permette invece una scalata per ruoli:

1. separare subito il gateway realtime/SSE usando outbox relazionale;
2. poi introdurre worker di lettura dove i read model sono sufficientemente esternalizzati;
3. infine abilitare worker ordine solo quando la mutazione ordine e i suoi side effect sono
   coordinati da relazionale/MySQL, non da memoria locale.

## Prossimi step consigliati

### Step MP-1 - Processo realtime dedicato

Implementato come opt-in nello script Linux:

```text
BACKEND_REALTIME_GATEWAY_ENABLED=1
BACKEND_REALTIME_PORT=5282
```

Con questo flag `tools/restart-cassav4-linux.sh` avvia:

```text
backend owner       -> 127.0.0.1:5281, BACKEND_PROCESS_ROLE=api-owner
backend realtime    -> 127.0.0.1:5282, BACKEND_PROCESS_ROLE=realtime-gateway
frontend multiplexer -> BACKEND_REALTIME_ORIGIN=http://127.0.0.1:5282
```

Quando il gateway realtime e' abilitato, lo script abilita anche l'outbox ma lascia spento lo
shadow sync full-domain:

```text
EVENT_OUTBOX_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED=0
```

Questo permette di usare `event_outbox` come coordinamento cross-process senza riattivare il costo
di sincronizzazione relazionale shadow su ogni `writeDb`.

`serve-frontends.mjs` instrada solo:

```text
GET /api/integration/notifications/stream
```

verso quel processo; tutte le altre API restano su `BACKEND_ORIGIN`.
Il processo gateway usera' `event_outbox` per drenare eventi e mantenere i client SSE, togliendo
fan-out e heartbeat SSE dal processo owner.

### Step MP-2 - Proxy route-aware

Implementato nel multiplexer HTTPS (`serve-frontends.mjs`) con il registro route backend e la stessa
classificazione di `backend/core/process-topology.js`.

```text
stream realtime -> realtime-gateway
mutazioni       -> api-owner, salvo route abilitate esplicitamente ai worker
letture         -> api-worker quando sicure, fallback owner
```

Le letture restano sull'owner finche' non sono presenti entrambi i flag:

```text
BACKEND_MULTI_PROCESS_READ_WORKERS=1
BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED=1
```

Anche con i flag attivi serve un origin worker esplicito:

```text
BACKEND_API_WORKER_ORIGIN=http://127.0.0.1:<porta>
```

Le mutazioni ordine possono andare su `api-worker` solo con i prerequisiti gia' previsti per MP-4.
Le altre mutazioni restano sempre sull'owner. Il proxy aggiunge gli header diagnostici
`X-Proxy-Backend-Role` e, in caso di fallback, `X-Proxy-Backend-Desired-Role`.

### Step MP-2b - API worker opt-in senza job owner

Implementato nello script Linux come opt-in:

```text
BACKEND_API_WORKER_ENABLED=1
BACKEND_API_WORKER_PORT=5283
```

Con questo flag `tools/restart-cassav4-linux.sh` avvia:

```text
backend api-worker -> 127.0.0.1:5283, BACKEND_PROCESS_ROLE=api-worker
frontend multiplexer -> BACKEND_API_WORKER_ORIGIN=http://127.0.0.1:5283
```

L'api-worker non riceve traffico dal proxy finche' non sono attivi anche:

```text
BACKEND_MULTI_PROCESS_READ_WORKERS=1
BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED=1
```

Questo mantiene il rollout a due stadi: prima processo worker avviabile e innocuo, poi routing delle
letture quando il read state e' dichiarato esternalizzato.

### Step MP-2c - Routing letture su API worker

Verificato su runtime live con:

```text
owner            -> 127.0.0.1:5281
realtime-gateway -> 127.0.0.1:5282
api-worker       -> 127.0.0.1:5283
frontend proxy   -> 127.0.0.1:5280
```

Flag proxy attivi:

```text
BACKEND_API_WORKER_ORIGIN=http://127.0.0.1:5283
BACKEND_MULTI_PROCESS_READ_WORKERS=1
BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED=1
```

Esito atteso e verificato:

```text
GET read API -> X-Proxy-Backend-Role: api-worker
POST mutation API -> X-Proxy-Backend-Role: api-owner
GET notifications stream -> X-Proxy-Backend-Role: realtime-gateway
direct POST mutation su api-worker -> 503 BACKEND_PROCESS_ROUTE_BLOCKED
```

### Step MP-2f - Canary misto owner + api-worker + realtime-gateway

Implementato:

```text
cassa-frontend/scripts/multiprocess-mixed-canary.mjs
npm --prefix cassa-frontend run canary:multiprocess-mixed
```

Il canary esegue nello stesso intervallo:

```text
- letture sostenute via frontend proxy
- publish notifiche via owner
- stream SSE via realtime-gateway
- cleanup notifiche sintetiche via owner
- mutazione diretta verso api-worker, che deve restare bloccata
- controllo outbox relazionale senza eventi pendenti
```

Questo verifica il contratto multi-processo in combinazione, non solo per singolo ruolo isolato.

### Step MP-2g - Preflight P con gate multi-processo

Il preflight di Fase P ora include anche il blocco multi-processo:

```text
cassa-frontend/scripts/phase-p-validation-preflight.mjs
npm --prefix cassa-frontend run preflight:phase-p
```

Il report generato verifica la presenza degli script canary MP e produce i comandi standard per:

```text
- api-worker-reads-30s
- realtime-gateway-8x8
- mixed-30s
```

Soglie tracciate nel piano:

```text
multiProcessReadP95Ms <= 200
multiProcessFirstDeliveryP95Ms <= 500
multiProcessAllStreamsDeliveryP95Ms <= 750
multiProcessOutboxUnpublished = 0
multiProcessDirectWorkerMutationBlocked = true
```

### Step MP-3 - Externalized state ordine

### Step MP-3a - Audit readiness order workflow

Implementato:

```text
cassa-frontend/scripts/order-workflow-externalization-audit.mjs
npm --prefix cassa-frontend run audit:order-workflow-externalization
```

L'audit enumera tutte le route `order-workflow`, associa per ognuna flag write-primary, test
disponibili, side effect gia' esternalizzati e bloccanti rimasti.

Esito attuale:

```text
route order-workflow: 14
coperte da write-primary relazionale: 5
pronte per order worker: 0
bloccate: 14
metadata mancanti: 0
go/no-go order workers: NO-GO
```

Il `NO-GO` e' intenzionale: impedisce di abilitare `BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1`
finche' tavoli, financial sync, notifiche, audit/permessi e idempotenza cross-process non sono stati
separati dallo stato owner in memoria.

### Step MP-3b - Fuse esplicito per order worker

Il route guard/proxy ora richiede un ulteriore flag di go/no-go:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1
```

Questo flag si aggiunge ai prerequisiti tecnici:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKERS=1
BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1
BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1
BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1
```

Senza `BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1`, le route `order-workflow` restano
instradate all'owner anche se gli altri flag sono impostati. Il fuse evita che un deploy abiliti
worker ordine mentre l'audit MP-3a e' ancora `NO-GO`.

### Step MP-3c - Diagnostica prerequisiti order worker

Il report topologia espone ora lo stato puntuale dei prerequisiti order worker:

```text
npm --prefix cassa-frontend run report:process-topology
```

Esempio con tutti i prerequisiti tecnici attivi ma audit ancora non approvato:

```text
order workers enabled: no

Order worker prerequisites:
- OK BACKEND_MULTI_PROCESS_ORDER_WORKERS
- OK BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED
- OK BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY
- OK BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH
- MISSING BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO
```

Questo rende immediatamente visibile il motivo per cui MP-4 non parte.

### Step MP-3d - Warning operativo nello script di restart

`tools/restart-cassav4-linux.sh` stampa ora i prerequisiti order worker prima del restart.

Con flag tecnici parziali:

```text
Order worker prerequisites:
- OK BACKEND_MULTI_PROCESS_ORDER_WORKERS
- OK BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED
- OK BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY
- OK BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH
- MISSING BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO
WARNING: order workers requested partially; order mutations will stay routed to owner.
```

Con tutti i prerequisiti, incluso audit GO:

```text
Order workers: prerequisites complete; route guard may allow order-workflow on api-worker.
```

Questo rende evidente in console quando un avvio multi-processo sta usando solo read-worker/realtime
e non ancora order-worker.

### Step MP-3e - Canary runtime fuse order worker

Implementato:

```text
cassa-frontend/scripts/order-worker-fuse-canary.mjs
npm --prefix cassa-frontend run canary:order-worker-fuse
```

Il canary usa una richiesta ordine volutamente invalida, senza side effect, e verifica:

```text
- POST /api/integration/orders/create via proxy -> X-Proxy-Backend-Role: api-owner
- POST /api/integration/orders/create diretto su api-worker -> 503 BACKEND_PROCESS_ROUTE_BLOCKED
```

Il preflight P include ora anche `order-worker-fuse` tra i canary multi-processo.

### Step MP-3f - E2E proxy fuse order worker

Aggiunto test e2e sul multiplexer HTTPS:

```text
cassa-frontend/backend/tests/static-proxy.e2e.test.mjs
```

Scenario verificato:

```text
- flag tecnici order worker attivi, audit GO assente -> orders/create va a api-owner
- flag tecnici order worker attivi, audit GO presente -> orders/create va a api-worker
```

Questo copre `serve-frontends.mjs`, non solo il route guard core.

### Step MP-3g - Audit GO verificato dal restart

`tools/restart-cassav4-linux.sh` non accetta piu' il fuse order worker solo come flag manuale.
Se `BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1` e' richiesto, lo script esegue:

```text
cassa-frontend/scripts/order-workflow-externalization-audit.mjs --json-only --no-write
```

Se l'audit corrente non restituisce `orderWorkersGoNoGo: go`, il restart forza per i processi avviati:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=0
```

La modalita' `--no-write` emette solo JSON e non crea nuovi report, quindi puo' essere usata a ogni restart
senza sporcare i log.

### Step MP-3h - Allowlist route per order worker

Anche quando audit e prerequisiti tecnici saranno verdi, le route ordine non vengono piu' aperte tutte
insieme. Serve una allowlist esplicita:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST="POST /api/integration/orders/create"
```

Valori accettati:

```text
- route key completa: POST /api/integration/orders/create
- pathname: /api/integration/orders/create
- wildcard consapevole: * (richiede anche BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD=1)
```

Senza allowlist, il report mostra:

```text
order workers enabled: no
- MISSING BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST
Order worker route allowlist:
- empty
```

Con allowlist su una sola route, solo quella route puo' essere instradata a `api-worker`; le altre
route `order-workflow` restano su `api-owner`.

### Step MP-3i - Doppio consenso per wildcard order worker

La allowlist wildcard `*` non e' sufficiente da sola. Se viene impostata:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST="*"
```

serve anche:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD=1
```

Senza il secondo flag, il report topologia resta:

```text
order workers enabled: no
- MISSING BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD
Order worker route allowlist:
- *
```

Lo script di restart passa il flag wildcard ai processi solo se impostato e lo mostra nei prerequisiti
solo quando la allowlist contiene `*`.

### Step MP-3j - Matrice bloccanti order workflow

L'audit MP-3 ora produce anche una matrice strutturata per dimensione bloccante.

Output principale:

```text
write-primary: 9 route
financial-sync: 8 route
notifications: 8 route
audit-permissions: 4 route
table-state: 4 route
app-state-mirror: 2 route
dbcache: 2 route
locks-handoff: 2 route
```

Ogni route espone `blockerDimensions` in JSON e nella tabella markdown. Questo rende il prossimo
refactor selezionabile per asse trasversale, non solo per endpoint:

```text
- prima chiudere write-primary mancanti
- poi isolare financial-sync/table-state dal processo owner
- poi portare notifiche e handoff su outbox/read model condiviso
```

Prima di abilitare `BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1`, chiudere almeno:

```text
- read/write primary reale per ordini e revisioni
- side effect tavoli/financial sync senza dipendenza da dbCache locale
- notifiche ordine via outbox o store condiviso
- idempotenza cross-process
- riconciliazione mirror app-state non distruttiva
```

### Step MP-4a - Ranking candidati order worker

L'audit order workflow ora calcola anche una graduatoria operativa per scegliere il primo refactor
da portare su worker senza aprire tutte le route insieme.

Top candidati attuali:

```text
1. POST /api/integration/orders/sync    score 37
2. POST /api/integration/orders/create  score 35
3. POST /api/integration/orders/comp    score 30
4. POST /api/integration/orders/correct score 22
5. POST /api/integration/orders/cancel  score 12
```

I primi candidati sono quelli con write-primary gia presente. Restano comunque `NO-GO` perche'
hanno side effect owner-bound, quindi la prossima attivita' e' estrarre prima:

```text
- sync: stato tavolo/dbCache, idempotenza e notifiche
- create: financial-sync, stato tavolo, notifiche e assegnazione postazione
- comp/correct/cancel: financial-sync, mirror app-state e notifiche
```

Batch consigliati dall'audit:

```text
batch-1-primary-covered-side-effects:
  sync, create, comp, correct, cancel

batch-2-add-write-primary-low-risk:
  replacement/bar-charge, legacy bar-charge, line/split

batch-3-admin-fiscal-transfer:
  correct/resolve, transfer request/resolve/force, price-override, storno
```

Il JSON espone ora:

```text
topOrderWorkerCandidates
orderWorkerCandidateRanking
recommendedOrderWorkerBatches
```

Report rigenerato:

```text
cassa-frontend/logs/order-workflow-externalization-audit-20260704165723/REPORT.md
```

### Step MP-4b - Gate route-scoped per allowlist order worker

Il restart non usa piu' soltanto il GO globale dell'audit. Quando e' presente:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST
```

lo script esegue l'audit con:

```text
--route-allowlist "<valore allowlist>"
```

e accetta `BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1` solo se:

```text
orderWorkerAllowlistAudit.goNoGo === "go"
```

Questo rende possibile il rollout incrementale route-per-route: in futuro una singola route potra'
essere instradata su worker quando e' pronta, anche se le altre route ordine restano bloccate.

Con lo stato attuale, la allowlist della candidata numero 1 resta correttamente bloccata:

```text
BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST="POST /api/integration/orders/sync"
orderWorkerAllowlistAudit.goNoGo: no-go
blocchi: table-state, notifications, dbcache
prossima azione: isolare stato tavolo dal dbCache owner
```

Il markdown dell'audit mostra ora anche:

```text
## Audit allowlist order worker
```

Report con allowlist `orders/sync`:

```text
cassa-frontend/logs/order-workflow-externalization-audit-20260704170142/REPORT.md
```

### Step MP-4c - Idempotenza terminale sync su lettura relazionale

`orders/sync` aveva un blocco `idempotency` per i duplicate terminali `ready/delivered`.
Prima di questo step, il pre-lane duplicate era disattivato quando
`BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1`, quindi una sync terminale duplicata passava nella
order lane e poteva arrivare fino al CAS relazionale.

Implementato:

```text
findRelationalOrderById()
tryHandleTerminalDuplicateOrderSyncPreLane(... readRelationalOrderById ...)
```

Comportamento nuovo:

```text
- se write-primary sync e' attivo, il pre-lane legge l'ordine dal relazionale
- se l'ordine e' gia ready/delivered e il payload e' terminale duplicato, risponde 200 noop
- non entra nella order lane e non incrementa la revisione
- mantiene il percorso app-state precedente quando il write-primary relazionale e' spento
```

Metriche aggiunte:

```text
orderTerminalDuplicateSyncRelationalPreLaneNoops
orders.sync.relationalRead
```

`orders/sync` ora resta bloccata solo su:

```text
table-state
notifications
dbcache
```

Report con allowlist `orders/sync` aggiornato:

```text
cassa-frontend/logs/order-workflow-externalization-audit-20260704170831/REPORT.md
```

### Step MP-4d - Outbox realtime obbligatorio per order worker

Con SSE instradate al `realtime-gateway`, un `api-worker` non deve mai affidarsi al fan-out
in memoria locale per eventi ordine. Da questo step, gli order worker richiedono esplicitamente:

```text
EVENT_OUTBOX_ENABLED=1
```

Il requisito e' stato aggiunto a:

```text
backend/core/process-topology.js
tools/restart-cassav4-linux.sh
scripts/phase-p-validation-preflight.mjs
```

Effetto operativo:

```text
- se EVENT_OUTBOX_ENABLED manca, orderWorkersEnabled=false
- il proxy lascia le route order-workflow su api-owner
- wildcard/allowlist non bypassano questo requisito
- il restart usa il valore effettivo EVENT_OUTBOX_FLAG, quindi realtime-gateway abilita anche outbox
```

Questo non chiude ancora tutto il blocco `notifications` di `orders/sync`, perche' resta da
separare il record notifica persistente dal dbCache locale, ma impedisce la perdita degli eventi SSE
quando si arrivera' al primo canary con order worker.

### Step MP-4e - Blocco notifiche sync raffinato

L'audit `orders/sync` ora distingue due piani:

```text
- realtime SSE: esternalizzato tramite event_outbox obbligatorio
- record campanella persistente: ancora locale in db.integration.notifications
```

Per evitare che il gate order worker continui a confondere questi due piani, il blocco
`notifications` della route sync e' stato sostituito da `notification-record`.

Evidenza runtime aggiunta:

```text
backend/tests/realtime-event-outbox.e2e.test.mjs
```

Il test marca una comanda come pronta via `POST /api/integration/orders/sync` e verifica che
`order_ready` e `order_state_changed` siano entrambi conservati in `event_outbox` come eventi
`order.status`, anche senza stream SSE aperti.

Stato audit dopo MP-4e:

```text
orders/sync: NO-GO
blocchi: table-state, notification-record, dbcache
score: 47
report: cassa-frontend/logs/order-workflow-externalization-audit-20260704171711/REPORT.md
```

### Step MP-4f - Telemetria side effect tavolo in orders/sync

Prima di estrarre `table-state` dal processo owner serve sapere quante sync toccano davvero
`posSettings.tables` e quante attraversano il ricalcolo come no-op. Sono stati aggiunti due contatori
runtime:

```text
orderSyncTableStateChanged
orderSyncTableStateNoops
```

Il punto misurato e' immediatamente dopo `syncPosTableFinancialsFromIntegrationOrders` nella route
`POST /api/integration/orders/sync`, cioe' prima di decidere se aggiungere `posSettings` agli
`extraSplitDomains`.

Questo non abilita ancora order worker, ma rende il prossimo canary capace di misurare il peso reale
del blocco `table-state` invece di stimarlo a mano.

### Step MP-4 - Order workers

Solo dopo MP-4a e dopo la chiusura dei blocchi del batch scelto abilitare route ordine su
`api-worker` e misurare canary 50/100 device con:

```text
owner + N worker ordine + realtime-gateway
```

## Verifiche

```text
node --check backend/core/process-topology.js: OK
node --check backend/server.js: OK
node --check serve-frontends.mjs: OK
node --check scripts/backend-process-topology-report.mjs: OK
bash -n tools/restart-cassav4-linux.sh: OK
node --test backend/tests/process-topology.test.mjs: 8/8
route-policy + topology + proxy + line-budget: 63/63
server.js line budget: 38.795 / 39.500 (margine 705)
runtime smoke realtime-gateway su porta 5292: health OK, orders/create bloccata con BACKEND_PROCESS_ROUTE_BLOCKED
runtime live owner+gateway su 5281/5282/5280: OK
SSE e2e via frontend: notification_publish pubblicata dall'owner e consegnata dallo stream gateway
cleanup notifica test ntf_0003228: deleted true
outbox DB dopo drain SSE: unpublished=0
node --check scripts/realtime-gateway-canary.mjs: OK
node --check scripts/multiprocess-mixed-canary.mjs: OK
node --check scripts/order-workflow-externalization-audit.mjs: OK
canary realtime-gateway smoke 3x3: 9/9 delivery, outbox unpublished=0
canary realtime-gateway 20x20: 400/400 delivery, first p95=171.79ms, all-streams p95=176.08ms, publish p95=389.33ms, cleanup=20/20, outbox unpublished=0
report canary: logs/realtime-gateway-canary-rtgw_20260704T151534/REPORT.md
MP-2 proxy route-aware: test static-proxy e2e owner/read-worker/realtime OK
test mirati MP-2: 62/62 pass
runtime frontend proxy ricaricato su 5280: health -> X-Proxy-Backend-Role=api-owner
runtime stream SSE -> X-Proxy-Backend-Role=realtime-gateway
canary post-reload MP-2 10x10: 100/100 delivery, first p95=192.53ms, all-streams p95=193.69ms, outbox unpublished=0
report canary post-reload: logs/realtime-gateway-canary-rtgw_20260704T152312/REPORT.md
MP-2b api-worker owner-job guard: health OK su 5293, GET /api/integration/menu=200, POST /api/integration/orders/create=503 BACKEND_PROCESS_ROUTE_BLOCKED
MP-2b log worker: "Processo api-worker: worker stampa/fiscale/scheduler owner disattivati."
test mirati MP-2b: 63/63 pass
MP-2c api-worker read routing: 25/25 letture su api-worker, read p95=34.29ms, mutazioni su owner, direct worker mutation blocked, SSE su realtime
report canary api-worker: logs/api-worker-read-canary-apiw_20260704T161942/REPORT.md
MP-2c realtime canary con api-worker attivo 5x5: 25/25 delivery, first p95=228.69ms, all-streams p95=235.11ms, outbox unpublished=0
report canary realtime post api-worker: logs/realtime-gateway-canary-rtgw_20260704T162003/REPORT.md
MP-2d api-worker read medium concurrency: 20 iterazioni, concorrenza 12, 100/100 letture su api-worker, 20/20 health su owner, read p50=22.87ms, read p95=293.78ms, max=375.54ms
MP-2d path p95: layout=368.82ms, waiters=315.48ms, stations/state=293.78ms, stations/active=287.44ms, menu=49.33ms, health=63.49ms
report canary api-worker medium: logs/api-worker-read-canary-apiw_20260704T162214/REPORT.md
MP-2d realtime canary finale con api-worker attivo 8x8: 64/64 delivery, first p95=237.04ms, all-streams p95=244.54ms, outbox unpublished=0
report canary realtime finale: logs/realtime-gateway-canary-rtgw_20260704T162244/REPORT.md
MP-2e api-worker read duration: 30s, concorrenza 12, delay 250ms, 1401 probe totali, 1167/1167 letture su api-worker, 234/234 health su owner, errori=0
MP-2e read duration timing: p50=2.02ms, p95=8.55ms, max=380.35ms
MP-2e path p95: layout=150.58ms, stations/active=124.19ms, stations/state=61.24ms, health=5.32ms, menu=4.43ms, waiters=3.09ms
report canary api-worker duration: logs/api-worker-read-canary-apiw_20260704T162500/REPORT.md
MP-2e realtime canary post-duration 8x8: 64/64 delivery, first p95=267.94ms, all-streams p95=270.32ms, outbox unpublished=0
report canary realtime post-duration: logs/realtime-gateway-canary-rtgw_20260704T162550/REPORT.md
MP-2f canary misto 30s: read 760/760 su api-worker, health 153 su owner, deliveries 40/40, publish owner OK, SSE realtime OK, direct worker mutation blocked, outbox unpublished=0
MP-2f timing: read p95=55.45ms, first delivery p95=268.27ms, all-streams p95=271.92ms
report canary misto: logs/multiprocess-mixed-canary-mpmixed_20260704T162930/REPORT.md
MP-2g preflight P aggiornato: include canary multi-process api-worker, realtime-gateway e mixed; esito OK, missing=0
report preflight: cassa-frontend/logs/phase-p-preflight-20260704163154/REPORT.md
test phase-p-validation-preflight: 3/3 pass
MP-3a audit order workflow: 14 route, write-primary covered 5, ready 0, blocked 14, metadata missing 0, order workers NO-GO
report audit MP-3a: cassa-frontend/logs/order-workflow-externalization-audit-20260704163414/REPORT.md
preflight P rigenerato con audit MP-3a: cassa-frontend/logs/phase-p-preflight-20260704163421/REPORT.md
test MP-3a + preflight + topology: 13/13 pass
MP-3b fuse order worker: senza BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 orderWorkersEnabled=false anche con gli altri flag tecnici
MP-3b fuse order worker: con BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 orderWorkersEnabled=true
test MP-3b + proxy/preflight/audit/topology: 21/21 pass
MP-3c topology report prerequisiti: con flag tecnici attivi e audit GO assente mostra MISSING BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO
test MP-3c + proxy/topology/budget: 17/17 pass
MP-3d restart warning: bash -n OK, warning operativo verificato senza riavvio per audit GO mancante e completo
MP-3e canary order worker fuse live: proxyOwner=true, directWorkerBlocked=true, proxyStatus=401, workerStatus=503
report canary MP-3e: logs/order-worker-fuse-canary-orderfuse_20260704T163946/REPORT.md
preflight P rigenerato con canary order-worker-fuse: cassa-frontend/logs/phase-p-preflight-20260704163957/REPORT.md
test MP-3e + preflight/proxy/topology/budget: 20/20 pass
MP-3f proxy e2e fuse: senza audit GO orders/create resta api-owner, con audit GO va api-worker
test MP-3f + topology/budget: 18/18 pass
MP-3g audit GO verified restart: con audit corrente NO-GO e flag richiesto, restart force effective GO=0 senza scrivere report
test MP-3g + audit/preflight/proxy/topology/budget: 24/24 pass
MP-3h order worker route allowlist: audit GO non basta; serve BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST esplicita
MP-3h proxy e2e: allowlist create manda solo orders/create a api-worker, orders/sync resta api-owner
preflight P rigenerato con requisito allowlist: cassa-frontend/logs/phase-p-preflight-20260704164639/REPORT.md
test MP-3h + preflight/proxy/topology/budget: 21/21 pass
MP-3i wildcard order worker: allowlist * richiede anche BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD=1
MP-3i report: wildcard senza consenso -> orderWorkersEnabled=false; wildcard con consenso -> orderWorkersEnabled=true
test MP-3i + preflight/proxy/topology/budget: 22/22 pass
MP-3j audit blocker matrix: write-primary=9, financial-sync=8, notifications=8, table-state=4
report audit MP-3j: cassa-frontend/logs/order-workflow-externalization-audit-20260704165300/REPORT.md
test MP-3j + topology/proxy/budget: 23/23 pass
MP-4a audit order worker candidate ranking: top sync/create/comp/correct/cancel, batch consigliati generati
report audit MP-4a: cassa-frontend/logs/order-workflow-externalization-audit-20260704165723/REPORT.md
test MP-4a + topology/proxy/budget: 24/24 pass
MP-4b audit route-scoped allowlist: restart verifica orderWorkerAllowlistAudit.goNoGo prima di accettare audit GO
MP-4b allowlist sync: no-go, blocchi idempotency/table-state/notifications/dbcache (prima di MP-4c)
report audit MP-4b: cassa-frontend/logs/order-workflow-externalization-audit-20260704170142/REPORT.md
test MP-4b + topology/proxy/budget: 26/26 pass
MP-4c sync terminal duplicate: pre-lane legge dal relazionale con write-primary attivo, no order lane, no bump revisione
MP-4c allowlist sync: no-go, blocchi table-state/notifications/dbcache, score 47
report audit MP-4c: cassa-frontend/logs/order-workflow-externalization-audit-20260704170831/REPORT.md
test MP-4c + audit/topology/proxy/budget/route-policy: 76/76 pass
MP-4d order worker outbox fuse: EVENT_OUTBOX_ENABLED=1 obbligatorio per order worker e preflight P
MP-4d proxy/topology/preflight/budget: 22/22 pass
MP-4e sync notification refinement: orders/sync distingue SSE outbox da record campanella locale
MP-4e allowlist sync: no-go, blocchi table-state/notification-record/dbcache, score 47
report audit MP-4e: cassa-frontend/logs/order-workflow-externalization-audit-20260704171711/REPORT.md
MP-4e test mirati audit/outbox/proxy/topology/preflight/budget: 34/34 pass
MP-4f runtime metrics table-state sync: aggiunti orderSyncTableStateChanged/orderSyncTableStateNoops
MP-4f test mirati runtime/orders-flow/route-policy/budget: 60/60 pass
MP-4g report stress table-state: loadtest-full-capacity/endurance-sim-50k mostrano changed/no-op/rate
MP-4g check script + route-policy: 48/48 pass
MP-4h order worker table-state fuse: richiesto BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized
MP-4h topology/preflight/proxy/restart/budget: 22/22 pass
MP-4i orders/sync tableStates e2e: con split externalized aggiorna tableStates e non riscrive stato operativo tavolo nel JSON primario
MP-4i orders-flow/route-policy/budget: 58/58 pass
MP-4j audit sync table-state chiuso: orders/sync resta NO-GO solo per notification-record/dbcache, score 56
report audit MP-4j: cassa-frontend/logs/order-workflow-externalization-audit-20260704173313/REPORT.md
MP-4j audit test: 7/7 pass
MP-4k order worker notification-record fuse: richiesto BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1 per dominio notifiche condiviso
MP-4k topology/proxy/preflight/restart/budget: 22/22 pass, bash -n OK, node --check OK
MP-4l audit sync notification-record chiuso: orders/sync resta NO-GO solo per dbcache, score 65
MP-4l repository proof: bulk integration sync scrive orders + notifications + object fields come righe split selettive
report audit MP-4l: cassa-frontend/logs/order-workflow-externalization-audit-20260704174000/REPORT.md
MP-4l audit/route-policy/budget + repository mirato: 57/57 + 1/1 pass
MP-4m dbcache bridge: count/preparation queue reconciliation accettano snapshot ordini esterno oltre a db.integration.orders
MP-4m audit evidence: orders/sync include test coda preparazione snapshot adapter, score 65, NO-GO resta solo dbcache
report audit MP-4m: cassa-frontend/logs/order-workflow-externalization-audit-20260704174255/REPORT.md
MP-4m preparation-queue/audit/budget/route-policy: 71/71 + 29/29 pass, node --check OK
MP-4n dbcache bridge: retrocessione prep vuote per cambio selezione produce piano puro su snapshot ordini esterno
MP-4n wrapper compatibile: demoteEmptyPreparationOrdersForSelection continua a mutare db.integration.orders senza cambiare il chiamante
report audit MP-4n: cassa-frontend/logs/order-workflow-externalization-audit-20260704174510/REPORT.md
MP-4n preparation-queue/route-policy/budget + audit: 72/72 + 30/30 pass, node --check OK
MP-4o orders/sync preparation plan: ingresso prep usa piano unico snapshot-ready per demotion e limite coda
MP-4o server bridge: handler sync applica syncPreparationPlan e non chiama piu demotion/count direttamente sul dbCache
report audit MP-4o: cassa-frontend/logs/order-workflow-externalization-audit-20260704174924/REPORT.md
MP-4o preparation-queue/orders-flow/route-policy/budget + audit: 82/82 + 82/82 pass, node --check OK
MP-4p reconciliation apply plan: riconciliazione e promozione automatica coda usano piano applicativo snapshot-ready
MP-4p server bridge: reconcileIntegrationPreparationQueue applica reconciliationPlan unico e non ricompone piu plan+promotion nel wrapper
report audit MP-4p: cassa-frontend/logs/order-workflow-externalization-audit-20260704175220/REPORT.md
MP-4p preparation-queue/orders-flow/audit/route-policy/budget: 93/93 pass, node --check OK, server.js 38767 righe
MP-4q snapshot source: orders/sync e riconciliazione coda usano buildIntegrationOrderWorkflowSnapshotSource con sourceKind dbcache esplicito
MP-4q bridge read-model: modulo coda normalizza array/dbcache/read-model/snapshot come sorgenti intercambiabili
report audit MP-4q: cassa-frontend/logs/order-workflow-externalization-audit-20260704175835/REPORT.md
MP-4q preparation-queue/orders-flow/audit/route-policy/budget: 95/95 pass, node --check OK, server.js 38773 righe
MP-4r target/apply plan: orders/sync risolve l'ordine corrente e applica mergedOrder tramite target snapshot-ready, senza indice dbCache diretto
MP-4r bridge read-model: buildIntegrationOrderWorkflowApplyPlan produce nuovo snapshot ordini e preserva l'aggancio a sourceKind dbcache esplicito
report audit MP-4r: cassa-frontend/logs/order-workflow-externalization-audit-20260704180421/REPORT.md
MP-4r preparation-queue/orders-flow/relational-sync/audit/route-policy/budget: 99/99 pass, node --check OK, server.js 38781 righe
MP-4s relational snapshot: orders/sync usa listRelationalOrderWorkflowSnapshot quando BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY e' attivo
MP-4s CAS guard: la revisione attesa resta quella del payload client quando presente, evitando accettazione stale da snapshot relazionale corrente
report audit MP-4s: cassa-frontend/logs/order-workflow-externalization-audit-20260704183810/REPORT.md
MP-4s relational-orders/orders-flow/audit/route-policy/runtime/budget: 98/98 pass, node --check OK, server.js 38796 righe
MP-4t audit GO route-scoped: orders/sync non ha piu blocker dbcache ed e' la prima route readyForOrderWorker
MP-4t allowlist sync: BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST="POST /api/integration/orders/sync" restituisce orderWorkerAllowlistAudit.goNoGo=go
report audit MP-4t: cassa-frontend/logs/order-workflow-externalization-audit-20260704184121/REPORT.md
MP-4t audit/topology/route-policy/budget: 72/72 pass, node --check OK, readyForOrderWorker 1/14, server.js 38796 righe
MP-4u canary route-scoped: aggiunto order-worker-route-canary per verificare proxy target su api-worker, control route su api-owner e guard diretto del worker
MP-4u preflight P: include order-worker-sync-allowlist e audit --route-allowlist "POST /api/integration/orders/sync"
report preflight MP-4u: cassa-frontend/logs/phase-p-preflight-20260704184701/REPORT.md
MP-4u audit allowlist no-write: orderWorkersGoNoGo no-go globale, orderWorkerAllowlistAudit.goNoGo=go per orders/sync, readyForOrderWorker 1/14
MP-4u check/test mirati: node --check OK, preflight/topology/proxy/audit 28/28 pass, server.js 38796 righe
MP-4v restart preset: BACKEND_MULTI_PROCESS_ORDER_SYNC_CANARY=1 abilita owner api-owner, realtime-gateway, api-worker, read workers, table-state externalized, split domains, write-primary sync e allowlist solo orders/sync
MP-4v dry-run restart: BACKEND_RESTART_DRY_RUN=1 stampa topologia effettiva e non ferma/avvia processi
report preflight MP-4v: cassa-frontend/logs/phase-p-preflight-20260704185216/REPORT.md
MP-4v audit allowlist no-write: globale no-go, allowlist orders/sync go, readyForOrderWorker 1/14
MP-4v check/test: bash -n OK, node --check OK, preflight/topology/proxy/audit 29/29 pass, route-policy/budget 55/55 pass, server.js 38796 righe
MP-4w restart live preset: BACKEND_MULTI_PROCESS_ORDER_SYNC_CANARY=1 avviato su 5280/5281/5282/5283, LAN https://192.168.1.182:5280/mobile/
MP-4w route canary live: orders/sync -> api-worker, orders/create -> api-owner, direct worker sync allowed, direct worker create blocked
report canary route MP-4w: logs/order-worker-route-canary-orderroute_20260704T185426/REPORT.md
MP-4w mixed canary live 8s: read 119/119 su api-worker, health owner 24, read p95 173.34ms, deliveries 12/12, first p95 234.15ms, all-streams p95 235.12ms, outbox unpublished 0
report canary mixed MP-4w: logs/multiprocess-mixed-canary-mpmixed_20260704T185447/REPORT.md
MP-4w log current pid: owner 42829, realtime-gateway 42857, api-worker 42883, frontend 42910; nessun errore nuovo oltre warning sviluppo TOKEN/SQLite
MP-4x orders/sync e2e canary: aggiunto script cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs con guard PRINTING_ENABLED=0, login lorenzo/1234, create owner, sync worker, readback scoped e cleanup
MP-4x sessioni cross-process: readDb({ forceReload }) ora bypassa la cache anche sui repository strutturati; auth su api-worker forza reload per vedere subito le sessioni owner
MP-4x readback scoped: lookup puntuale integration.orders riconcilia dal relazionale write-primary quando la revisione relazionale e' piu nuova del mirror app-state
MP-4x cancel after worker sync: orders/cancel rilegge il relazionale write-primary prima del controllo revisione, evitando falsi REVISION_CONFLICT dopo sync su api-worker
report canary e2e MP-4x: logs/order-worker-sync-e2e-canary-ordersynce2e_20260704T191916/REPORT.md
MP-4x live e2e: createOwner=yes, syncWorker=yes, workflow prep, readback prep al primo tentativo, cleanup 200; stampa reale disabilitata durante il canary
MP-4x check/test: node --check OK; app-state/scoped 54/54 pass; preflight/topology/proxy/audit 29/29 pass; scoped/route-policy/budget 69/69 pass; I4 cancel+sync write-primary verdi dopo aggiornamento test CAS
MP-4y orders/create station assignment plan: estratto piano riusabile buildOrderCreateAutoAssignmentPlan con eligibility postazione/menu fuori dal server owner
MP-4y audit create: rimosso blocco station-assignment; orders/create resta NO-GO per financial-sync/table-state/notifications
report audit MP-4y: logs/order-workflow-externalization-audit-20260704193155/REPORT.md
MP-4y check/test: node --check OK; assignment/audit 10/10 pass; route-policy/budget 57/57 pass; load-balancer/menu 21/21 pass; topology/preflight 14/14 pass; static-proxy 8/8 pass; create write-primary 1/1 pass; station-pause-transfer 13/13 pass; server.js 38744 righe
MP-4z orders/create table financial plan: estratto buildOrderTableFinancialPlan per calcolare patch stato/importi tavolo fuori dal server owner
MP-4z audit create: rimosso blocco table-state; orders/create resta NO-GO per financial-sync/notifications, score 54
report audit MP-4z: logs/order-workflow-externalization-audit-20260704193911/REPORT.md
MP-4z check/test: node --check OK; table-plan/assignment 6/6 pass; audit 7/7 pass; route-policy/budget 58/58 pass; create write-primary 1/1 pass; orders-flow 8/8 pass; topology/preflight/static-proxy 22/22 pass; server.js 38683 righe
MP-4aa orders/create financial-sync source: create scrive prima il primary relazionale e calcola il conto da snapshot ordini relazionale quando disponibile
MP-4aa audit create: financial-sync resta NO-GO per mancanza guard anti-stale cross-process; evidence aggiunta su snapshot relazionale post-write-primary, score 54
report audit MP-4aa: logs/order-workflow-externalization-audit-20260704194509/REPORT.md
MP-4aa check/test: node --check OK; financial-source/table-plan/assignment 8/8 pass; audit/route-policy/budget 66/66 pass; create write-primary 1/1 pass; orders-flow 8/8 pass; topology/preflight 14/14 pass; server.js 38698 righe
MP-4ab orders/create financial table write guard: cattura revision tavolo dal relazionale prima del calcolo financial-sync, applica revision+1 ai tavoli modificati e persiste table_states con enforceRevision prima del mirror app-state
MP-4ab audit create: rimosso blocco financial-sync; orders/create resta NO-GO solo per notifiche order_created da spostare su outbox/read-model condiviso
report audit MP-4ab: logs/order-workflow-externalization-audit-20260704195132/REPORT.md
MP-4ab check/test: node --check OK; financial-guard/source/table-plan/assignment 11/11 pass; audit/route-policy/budget 63/63 pass; create write-primary 1/1 pass con table_states revision=2; orders-flow 8/8 pass; tables-bills/table-move 12/12 pass; servizi live 5280/5281/5282/5283 health 200; server.js 38786 righe
MP-4ac orders/create order_created outbox strict: publish realtime supporta requireOutbox senza fallback inline e create lo attiva quando BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY + EVENT_OUTBOX_ENABLED sono attivi
MP-4ac audit create: rimosso blocco notifications; readyForOrderWorker 2/14 con orders/create e orders/sync entrambi ready, score create 175
report audit MP-4ac: logs/order-workflow-externalization-audit-20260704195724/REPORT.md
report allowlist MP-4ac: logs/order-workflow-externalization-audit-20260704195811/REPORT.md con create+sync GO
MP-4ac check/test: node --check OK; realtime-event-outbox 5/5 pass con create write-primary; create write-primary 1/1 pass; route-policy/budget 61/61 pass; servizi live 5280/5281/5282/5283 health 200; server.js 38794 righe
MP-4ad preset canary create+sync: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY=1, allowlist default "POST /api/integration/orders/create,POST /api/integration/orders/sync", create/sync write-primary e audit GO
MP-4ad preflight P: canary aggiornati per create allowlist, sync allowlist ed e2e create+sync con create/sync attesi su api-worker; cleanup non-gating finche orders/cancel resta owner-only
MP-4ad restart live: profilo create+sync avviato su 5280/5281/5282/5283, LAN https://192.168.1.182:5280/mobile/
MP-4ad route canary create: create -> api-worker, cancel control -> api-owner, direct create allowed, direct cancel blocked; report logs/order-worker-route-canary-orderroute_create_20260704T220618/REPORT.md
MP-4ad route canary sync: sync -> api-worker, cancel control -> api-owner, direct sync allowed, direct cancel blocked; report logs/order-worker-route-canary-orderroute_sync_20260704T220618/REPORT.md
MP-4ad e2e live create+sync: login lorenzo/1234, create 200 su api-worker, sync 200 su api-worker, readback prep al primo tentativo; report logs/order-worker-sync-e2e-canary-ordersynce2e_createsync_20260704T220628/REPORT.md
MP-4ad cleanup boundary: orders/cancel resta non externalizzato e non vede subito gli ordini creati su worker; ordini canary 00368/00369 rimossi manualmente dal solo DB relazionale/outbox dopo verifica fingerprint canary
report audit MP-4ad: logs/order-workflow-externalization-audit-20260704200719/REPORT.md
report preflight MP-4ad: logs/phase-p-preflight-20260704200719/REPORT.md
MP-4ad check/test: bash -n OK; node --check OK; preflight/process-topology/static-proxy 22/22 pass; preflight 4/4 pass; route-policy/budget 61/61 pass; audit allowlist create+sync GO; servizi live 5280/5281/5282/5283 health 200
MP-4ae cancel lookup bootstrap: orders/cancel, pur restando owner-only, ora prova il relazionale write-primary quando il mirror app-state non contiene la comanda e reidrata il record prima del 404
MP-4ae e2e locale: relational-orders-cancel-write-primary 2/2 pass, incluso caso comanda presente nel relazionale e assente dal mirror app-state con shadow sync spento
MP-4ae live e2e create+sync: login lorenzo/1234, create 00370 su api-worker, sync prep su api-worker, readback al primo tentativo, cleanup cancel 200 su owner; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ae_20260704T221542/REPORT.md
MP-4ae check/test: node --check OK; route-policy/budget 60/60 pass; server.js 38791 righe; servizi live 5280/5281/5282/5283 health 200
MP-4af cancel realtime outbox strict: order_cancelled ora richiede event_outbox quando RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY + EVENT_OUTBOX_ENABLED sono attivi, senza fallback inline
MP-4af audit cancel: rimosso blocker notifications da orders/cancel; score cancel 21, restano app-state-mirror/table-state/financial-sync; readyForOrderWorker globale resta 2/14
MP-4af e2e locale: realtime-event-outbox 6/6 pass con order_cancelled in order.status outbox; audit+cancel 9/9 pass; route-policy+outbox 67/67 pass
MP-4af live e2e create+sync: login lorenzo/1234, create 00371 su api-worker, sync prep su api-worker, readback al primo tentativo, cleanup cancel 200; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4af_20260704T222310/REPORT.md
MP-4af check/live: node --check OK; server.js 38787 righe; servizi live 5280/5281/5282/5283 health 200; profilo canary create+sync riavviato su https://192.168.1.182:5280/mobile/
MP-4ag cancel financial/table-state guard: orders/cancel scrive prima il primary relazionale, poi ricalcola il tavolo da snapshot ordini relazionale e persiste table_state con guard anti-stale su revision
MP-4ag audit cancel: rimossi blocker financial-sync e table-state da orders/cancel; score cancel 42, resta solo app-state-mirror; nextAction "portare mirror app-state fuori dal percorso risposta"
MP-4ag e2e locale: relational-orders-cancel-write-primary 2/2 pass con table_state relazionale revision=3 e total_due_cents=0 dopo cancel; order/payments invariants 17/17 pass; realtime-event-outbox 6/6 pass; audit+route-policy 69/69 pass
MP-4ag live e2e create+sync: login lorenzo/1234, create 00372 su api-worker, sync prep su api-worker, readback al primo tentativo, cleanup cancel 200; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ag_20260704T222820/REPORT.md
MP-4ag check/live: node --check OK; server.js 38793 righe; servizi live 5280/5281/5282/5283 health 200; profilo canary create+sync riavviato su https://192.168.1.182:5280/mobile/
MP-4ah cancel async ACK: aggiunto ORDERS_CANCEL_ASYNC_ACK vincolato a RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY; orders/cancel passa defer al mirror app-state dopo write-primary/order outbox/table_state relazionale
MP-4ah startup reconcile/shadow filter: ORDERS_ANY_ASYNC_ACK include create/sync/cancel, quindi riconciliazione startup e filtro shadow coprono anche crash prima del flush cancel
MP-4ah audit cancel: orders/cancel readyForOrderWorker=true, blocker vuoti, score 165; readyForOrderWorker globale 3/14; allowlist create+sync+cancel go
MP-4ah e2e locale: relational-orders-async-ack 1/1 pass con create/sync/cancel e convergenza mirror; cancel+outbox 8/8 pass; order/payments invariants 17/17 pass; audit+route-policy 69/69 pass
MP-4ah live e2e create+sync: login lorenzo/1234, create 00373 su api-worker, sync prep su api-worker, readback al primo tentativo, cleanup cancel 200; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ah_20260704T223429/REPORT.md
MP-4ah check/live: node --check OK; server.js 38794 righe; servizi live 5280/5281/5282/5283 health 200; log runtime conferma Orders async ACK create=1 sync=1 cancel=1; profilo live ancora allowlist create+sync
MP-4ai preset canary create+sync+cancel: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY=1 con allowlist default "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel" e write-primary esplicito anche per cancel
MP-4ai preflight P: aggiunti canary route cancel, e2e create+sync+cancel con cleanup atteso su api-worker, preset restart dry-run/restart e audit allowlist create+sync+cancel
MP-4ai audit allowlist: create+sync+cancel GO, readyForOrderWorker 3/14, globale ancora NO-GO per le altre 11 route; comp resta prossimo candidato con financial-sync/app-state-mirror
MP-4ai restart live: profilo create+sync+cancel avviato su owner 5281, realtime-gateway 5282, api-worker 5283, frontend 5280; LAN https://192.168.1.182:5280/mobile/
MP-4ai route canary cancel: cancel -> api-worker, comp control -> api-owner, direct cancel allowed, direct comp blocked; report logs/order-worker-route-canary-orderroute_cancel_20260704T224127/REPORT.md
MP-4ai e2e live create+sync+cancel: login lorenzo/1234, create 00374 su api-worker, sync prep su api-worker, readback prep al primo tentativo, cleanup cancel 200 su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ai_20260704T224135/REPORT.md
MP-4ai check/live: bash -n OK; node --check OK; preflight 5/5 pass; topology/static-proxy 18/18 pass; audit/route-policy 69/69 pass; preflight report logs/phase-p-preflight-20260704204232/REPORT.md; health frontend/owner/realtime/worker 200
MP-4aj orders/comp financial-sync: dopo syncRelationalOrderPrimary, il calcolo tavolo usa listRelationalOrderWorkflowSnapshot + buildOrderFinancialSyncState e persiste table_state con guard revision prima del mirror app-state
MP-4aj audit comp: rimosso blocker financial-sync da orders/comp; comp resta NO-GO solo per app-state-mirror, score 42, nextAction "portare mirror app-state fuori dal percorso risposta"
report audit MP-4aj: logs/order-workflow-externalization-audit-20260704204742/REPORT.md
MP-4aj check/test: node --check OK; relational-orders-comp-write-primary 1/1 pass; audit+route-policy 70/70 pass; topology/static-proxy 18/18 pass; server.js 38799 righe
MP-4aj live post-restart: profilo create+sync+cancel riavviato su owner 5281, realtime 5282, api-worker 5283, frontend 5280; e2e create/sync/cancel ancora tutto su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4aj_20260704T224837/REPORT.md; health 200
MP-4ak orders/comp async ACK: aggiunto ORDERS_COMP_ASYNC_ACK vincolato a RELATIONAL_ORDERS_COMP_WRITE_PRIMARY; orders/comp passa defer al mirror app-state includendo orderComps e barChargeReplacements quando presenti
MP-4ak async e2e: relational-orders-async-ack ora copre create/sync/comp/cancel, verifica durabilita relazionale prima dell'ACK e convergenza mirror anche per integration.orderComps
MP-4ak audit comp: orders/comp readyForOrderWorker=true, asyncMirrorCovered=true, blocker vuoti, score 170; readyForOrderWorker globale 4/14; allowlist create+sync+cancel+comp GO
report audit MP-4ak: logs/order-workflow-externalization-audit-20260704205414/REPORT.md
MP-4ak check/test: node --check OK; async-ack+comp-write-primary 2/2 pass; audit+route-policy 70/70 pass; topology/static-proxy 18/18 pass; server.js 38799 righe
MP-4ak live post-restart: profilo live ancora create+sync+cancel, runtime log conferma Orders async ACK create=1 sync=1 cancel=1 comp=1; e2e create/sync/cancel verde su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ak_20260704T225455/REPORT.md; health 200
MP-4al preset canary create+sync+cancel+comp: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY=1 con allowlist default "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp" e write-primary esplicito anche per comp
MP-4al preflight P: aggiunti route canary comp, e2e create+sync+comp con workflow ready e comp atteso su api-worker, preset restart dry-run/restart e audit allowlist create+sync+cancel+comp; control route dei route-canary spostata da comp a correct
MP-4al audit allowlist: create+sync+cancel+comp GO, readyForOrderWorker 4/14, globale ancora NO-GO per le altre 10 route; prossimo candidato orders/correct con blocchi financial-sync/notifications/read-model
MP-4al restart live: profilo create+sync+cancel+comp avviato su owner 5281, realtime-gateway 5282, api-worker 5283, frontend HTTPS 5280; LAN https://192.168.1.182:5280/mobile/
MP-4al route canary comp: comp -> api-worker, correct control -> api-owner, direct comp allowed, direct correct blocked; report logs/order-worker-route-canary-orderroute_comp_mp4al_20260704T230238/REPORT.md
MP-4al e2e live create+sync+comp: login lorenzo/1234, create 00377 su api-worker, sync ready/delivered su api-worker, readback al primo tentativo, comp 200 su api-worker con totale/dovuto 0/0; report logs/order-worker-sync-e2e-canary-ordersynce2e_comp_mp4al_20260704T230249/REPORT.md
MP-4al check/test: bash -n OK; node --check OK; preflight 6/6 pass; async-ack+comp-write-primary 2/2 pass; audit+route-policy 70/70 pass; topology/static-proxy 18/18 pass; audit allowlist create+sync+cancel+comp GO; health frontend/owner/realtime/worker 200; server.js 38799 righe
MP-4am orders/correct financial-sync: quando BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY=1 la correzione salta il sync economico owner-bound dentro applyOrderCorrectionToDb, scrive prima il primary relazionale, poi ricalcola da listRelationalOrderWorkflowSnapshot + buildOrderFinancialSyncState e persiste table_state relazionale con guard revision prima del mirror app-state
MP-4am audit correct: rimosso blocker financial-sync da orders/correct; correct resta NO-GO per notifications/read-model, score 34, nextAction "spostare notifiche ordine su outbox/read model condiviso"; financial-sync globale scende da 5 a 4 route
report audit MP-4am: logs/order-workflow-externalization-audit-20260704225332/REPORT.md
MP-4am check/test: node --check OK; relational-orders-correct-write-primary 1/1 pass; audit+route-policy+correct 72/72 pass; topology/static-proxy/preflight 24/24 pass; server.js 38799 righe
MP-4am live post-restart: profilo create+sync+cancel+comp riavviato su owner 5281, realtime 5282, api-worker 5283, frontend 5280; e2e create/sync/comp ancora tutto su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4am_20260705T005424/REPORT.md; health 200
MP-4an orders/correct outbox strict: order_correction_applied ora richiede event_outbox quando BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY + EVENT_OUTBOX_ENABLED sono attivi, senza fallback inline sul fan-out locale
MP-4an audit correct: rimosso blocker notifications da orders/correct; correct resta NO-GO solo per read-model, score 43, nextAction "portare il read model correzioni fuori dal dbCache owner"; notifications globale resta 4 route sulle route resolve/transfer
report audit MP-4an: logs/order-workflow-externalization-audit-20260704225932/REPORT.md
MP-4an check/test: node --check OK; realtime-event-outbox/order-workflow-audit/route-policy/correct 80/80 pass; topology/static-proxy/preflight 24/24 pass; server.js 38799 righe
MP-4an live post-restart: profilo create+sync+cancel+comp riavviato su owner 5281, realtime 5282, api-worker 5283, frontend 5280; e2e create/sync/comp tutto su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4an_20260705T010055/REPORT.md; health frontend/owner/realtime/worker 200
MP-4ao orders/correct read-model: aggiunto adapter order-correction-read-model e merge scoped che preferisce il relazionale a pari revisione quando contiene lastCorrectionId/voidedAt/correctionStatus non ancora presenti nel mirror app-state
MP-4ao audit correct: rimosso blocker read-model da orders/correct; correct resta NO-GO solo per app-state-mirror, score 52, nextAction "portare mirror app-state fuori dal percorso risposta"; readyForOrderWorker resta 4/14
report audit MP-4ao: logs/order-workflow-externalization-audit-20260704230619/REPORT.md
MP-4ao check/test: node --check OK; order-correction-read-model/scoped-orders-read/audit/route-policy 88/88 pass; topology/static-proxy/preflight 24/24 pass; correct write-primary/outbox/async-ack 9/9 pass; server.js 38799 righe
MP-4ao live post-restart: profilo create+sync+cancel+comp riavviato su owner 5281, realtime 5282, api-worker 5283, frontend 5280; e2e create/sync/comp tutto su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ao_20260705T010743/REPORT.md; health frontend/owner/realtime/worker 200
MP-4ap orders/correct async ACK: aggiunto ORDERS_CORRECT_ASYNC_ACK vincolato a RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY; orders/correct passa defer al mirror app-state includendo orderCorrections
MP-4ap async queue: order-async-appstate-flush preserva integrationObjectFields nei batch coalescenti, cosi side object come orderCorrections/orderComps non vengono persi nel flush asincrono
MP-4ap audit correct: orders/correct readyForOrderWorker=true, asyncMirrorCovered=true, blocker vuoti, score 175; readyForOrderWorker globale 5/14; allowlist corrente resta create+sync+cancel+comp
report audit MP-4ap: logs/order-workflow-externalization-audit-20260704231348/REPORT.md
MP-4ap check/test: node --check OK; async queue + async ACK create/sync/comp/cancel/correct + audit + route-policy 78/78 pass; topology/static-proxy/preflight 24/24 pass; server.js 38799 righe
MP-4ap live post-restart: profilo create+sync+cancel+comp riavviato su owner 5281, realtime 5282, api-worker 5283, frontend 5280; runtime log conferma Orders async ACK create=1 sync=1 cancel=1 comp=1 correct=1; e2e create/sync/comp tutto su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ap_20260705T011517/REPORT.md; health frontend/owner/realtime/worker 200
MP-4aq preset canary create+sync+cancel+comp+correct: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY=1 con allowlist default "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct" e write-primary esplicito anche per correct
MP-4aq preflight P: aggiunti route canary correct, e2e create+correct+sync+comp con correct/comp attesi su api-worker, preset restart dry-run/restart e audit allowlist create+sync+cancel+comp+correct; control route dei route-canary spostata su correct/resolve
MP-4aq audit allowlist: create+sync+cancel+comp+correct GO, readyForOrderWorker 5/14, globale ancora NO-GO per le altre 9 route; prossimo gruppo batch-2 add-write-primary low-risk
report audit MP-4aq: logs/order-workflow-externalization-audit-20260704232139/REPORT.md
MP-4aq check/test: bash -n OK; node --check OK; preflight 7/7 pass; process-topology 10/10 pass; audit test 7/7 pass; static-proxy 8/8 pass; audit allowlist create+sync+cancel+comp+correct GO; server.js 38799 righe
MP-4aq restart live: profilo create+sync+cancel+comp+correct avviato su owner 5281, realtime-gateway 5282, api-worker 5283, frontend HTTPS 5280; LAN https://192.168.1.182:5280/mobile/; PID owner 87753, realtime 87782, api-worker 87811, frontend 87839
MP-4aq route canary correct: correct -> api-worker, correct/resolve control -> api-owner, direct correct allowed, direct correct/resolve blocked; report logs/order-worker-route-canary-orderroute_correct_mp4aq_20260705T012256/REPORT.md
MP-4aq e2e live create+correct+sync+comp: login lorenzo/1234, create su api-worker, correct su api-worker, sync ready/delivered su api-worker, comp 200 su api-worker; report logs/order-worker-sync-e2e-canary-ordersynce2e_correct_mp4aq_20260705T012256/REPORT.md
MP-4aq health/log: frontend/owner/realtime/worker health 200; runtime log conferma Orders async ACK create=1 sync=1 cancel=1 comp=1 correct=1
MP-4ar bar-charge write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY, usato anche dal flag globale BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY, per POST /api/integration/orders/replacement/bar-charge e alias legacy POST /api/orders/replacement/bar-charge
MP-4ar bar-charge financial sync: il carico banco/sostituzione ora incrementa revision/currentRevision, scrive il primary relazionale con CAS, poi ricalcola da listRelationalOrderWorkflowSnapshot + buildOrderFinancialSyncState e persiste table_state relazionale con guard revision prima del mirror app-state
MP-4ar audit: writePrimaryCovered 7/14, write-primary residui 7, financial-sync residui 2; le due route bar-charge restano bloccate solo da app-state-mirror, batch-2 low-risk ora contiene solo orders/line/split
report audit MP-4ar: logs/order-workflow-externalization-audit-20260704233039/REPORT.md
MP-4ar check/test: node --check OK; relational-orders-bar-replacement-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy 65/65 pass; server.js 38784 righe
MP-4ar restart live: profilo create+sync+cancel+comp+correct riavviato su owner 5281, realtime-gateway 5282, api-worker 5283, frontend HTTPS 5280; LAN https://192.168.1.182:5280/mobile/; PID owner 90081, realtime 90111, api-worker 90137, frontend 90166
MP-4ar live canary regressione: create+correct+sync+comp ancora tutto su api-worker, workflow delivered; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4ar_20260705T013132/REPORT.md; health frontend/owner/realtime/worker 200
MP-4as bar-charge async ACK: aggiunto ORDERS_BAR_REPLACEMENT_ASYNC_ACK vincolato a RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY; orders/replacement/bar-charge passa defer al mirror app-state conservando barChargeReplacements
MP-4as async queue/e2e: order-async-appstate-flush preserva barChargeReplacements nei batch coalescenti; relational-orders-async-ack ora copre create/sync/comp/cancel/correct/barReplacement e verifica convergenza di integration.barChargeReplacements
MP-4as audit: le due route bar-charge sono readyForOrderWorker=true, asyncMirrorCovered=true, blocker vuoti; readyForOrderWorker globale 7/14; top candidate include POST /api/integration/orders/replacement/bar-charge; batch-2 low-risk resta orders/line/split
report audit MP-4as: logs/order-workflow-externalization-audit-20260704233608/REPORT.md
MP-4as check/test: node --check OK; order-async-appstate-flush 5/5 pass; relational-orders-async-ack 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy 65/65 pass; server.js 38784 righe
MP-4as restart live: profilo create+sync+cancel+comp+correct riavviato su owner 5281, realtime-gateway 5282, api-worker 5283, frontend HTTPS 5280; LAN https://192.168.1.182:5280/mobile/; PID owner 91141, realtime 91168, api-worker 91196, frontend 91221
MP-4as health/log/live canary: frontend/owner/realtime/worker health 200; runtime log conferma Orders async ACK create=1 sync=1 cancel=1 comp=1 correct=1 barReplacement=1; regressione create+correct+sync+comp ancora tutta su api-worker, report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4as_20260705T013709/REPORT.md
MP-4at preset canary create+sync+cancel+comp+correct+barReplacement: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY=1 con allowlist default "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge" e write-primary esplicito anche per barReplacement
MP-4at e2e canary: order-worker-sync-e2e-canary supporta CANARY_REQUIRE_BAR_REPLACEMENT=1, misura barReplacementRole, usa lock bar_charge_replacement e poi prosegue su correct/sync/comp con la revisione aggiornata
MP-4at preflight P: aggiunti route canary barReplacement integration+legacy, e2e create+barReplacement+correct+sync+comp, preset restart dry-run/restart e audit allowlist completo fino a barReplacement
MP-4at check/test preliminare: bash -n OK; node --check OK su canary e preflight; preflight 8/8 pass; dry-run nuovo preset OK; audit allowlist completo GO mentre audit globale resta NO-GO per 7 route non ancora pronte
MP-4at live: profilo create+sync+cancel+comp+correct+barReplacement avviato con PRINTING_ENABLED=0; owner PID 92609, realtime PID 92641, api-worker PID 92666, frontend PID 92692; LAN https://192.168.1.182:5280/mobile/
MP-4at route/e2e canary live: barReplacement integration e legacy -> api-worker, correct/resolve control -> api-owner; e2e create+barReplacement+correct+sync+comp verde tutto su api-worker, ordine 00385, revisioni 2/3/4, readback 1 tentativo; report logs/order-worker-sync-e2e-canary-ordersynce2e_bar_mp4at_20260705T014456/REPORT.md
MP-4at health/log: frontend/owner/realtime/worker health 200; runtime log conferma Orders async ACK create=1 sync=1 cancel=1 comp=1 correct=1 barReplacement=1
MP-4au orders/line-split write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY (o globale BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY), incremento revision/currentRevision nello split e syncRelationalOrderPrimary con CAS prima del mirror app-state
MP-4au test: aggiunto relational-orders-line-split-write-primary.e2e con ordine qty=2, split qty=1, markDelivered, verifica raw_json/righe relazionali e conflitto stale 409 senza mirror app-state
MP-4au audit: line/split ora ha writePrimaryFlags e test; writePrimaryCovered sale a 8/14, blocker write-primary scende a 6; line/split resta NO-GO per canary cross-process, table-state e dbcache
MP-4au check/test: node --check server/audit OK; relational-orders-line-split-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 66/66 pass; audit globale ancora NO-GO, allowlist MP-4at invariata
MP-4au live: riavviato mantenendo preset create+sync+cancel+comp+correct+barReplacement con PRINTING_ENABLED=0; owner PID 95924, realtime PID 95951, api-worker PID 95978, frontend PID 96003; LAN https://192.168.1.182:5280/mobile/
MP-4au regression canary: e2e create+barReplacement+correct+sync+comp ancora tutto su api-worker, workflow delivered; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4au_regression_20260705T023203/REPORT.md
MP-4au health/log: frontend/owner/realtime/worker health 200; runtime log conferma Orders async ACK create=1 sync=1 cancel=1 comp=1 correct=1 barReplacement=1; server.js 38790 righe
MP-4av line/split dbcache blocker chiuso: il handler legge il read-model relazionale prima di readDb/app-state, preferisce il relazionale anche con mirror locale stale/mancante e ripristina il mirror dopo CAS riuscito
MP-4av shadow guard: quando almeno una rotta ordini e write-primary, lo shadow sync non fa piu replaceAll del dominio orders da app-state; anche l'equivalence check salta i domini esclusi dal predicate, evitando overwrite da mirror stale durante auth/migration
MP-4av CAS client-side: orders/line/split accetta expectedRevision/currentRevision/revision e rifiuta client stale con 409 REVISION_CONFLICT prima del write; se manca expectedRevision resta compatibile e usa la revisione relazionale corrente
MP-4av audit: line/split non ha piu blocker dbcache; resta NO-GO solo per canary/concorrenza cross-process e table-state; readyForOrderWorker resta 7/14, writePrimaryCovered 8/14
MP-4av check/test: node --check server/relational index/audit OK; relational-orders-line-split-write-primary 1/1 pass; route-policy-architecture 66/66 pass; order-workflow-externalization-audit 7/7 pass; relational-shadow 53/53 pass; audit CLI --json-only OK; server.js 38799 righe
MP-4av live: riavviato preset create+sync+cancel+comp+correct+barReplacement con PRINTING_ENABLED=0; owner PID 100573, realtime PID 100601, api-worker PID 100628, frontend PID 100654; health 5280/5281/5282/5283 tutti 200; LAN https://192.168.1.182:5280/mobile/
MP-4av regression canary: create+barReplacement+correct+sync+comp tutto su api-worker, workflow delivered e readback al primo tentativo; report logs/order-worker-sync-e2e-canary-ordersynce2e_mp4av_20260705T025223/REPORT.md
MP-4aw line/split table-state neutral: aggiunto controllo e2e che table_states relazionale resta identico dopo split/markDelivered; route-policy vieta financial/table-state sync dentro handleIntegrationOrderLineSplit
MP-4aw audit: rimosso blocker table-state da orders/line/split; resta solo concurrency-tests con nextAction "aggiungere canary e2e di concorrenza cross-process"; blockerDimensionSummary non contiene piu table-state
MP-4aw check/test: relational-orders-line-split-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 66/66 pass; audit CLI --json-only OK; health live 5280/5281/5282/5283 tutti 200; nessun restart necessario perche runtime server invariato
MP-4ax line/split cross-process canary: order-worker-sync-e2e-canary supporta CANARY_REQUIRE_LINE_SPLIT=1, crea qty=2, esegue split con expectedRevision e misura lineSplitRole/gate prima di sync
MP-4ax preset/preflight: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1 con allowlist default completa fino a POST /api/integration/orders/line/split, write-primary line-split esplicito, route canary e audit allowlist dedicati
MP-4ax audit: orders/line/split readyForOrderWorker=true, blocker vuoti, readyForOrderWorker globale 8/14; allowlist create+sync+cancel+comp+correct+barReplacement+lineSplit GO
MP-4ax check/test: node --check canary/preflight/audit OK; bash -n restart OK; relational-orders-line-split-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; phase-p-validation-preflight 9/9 pass; route-policy-architecture 67/67 pass
MP-4ax live: riavviato profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 103534, realtime PID 103560, api-worker PID 103585, frontend PID 103613; LAN https://192.168.1.182:5280/mobile/
MP-4ax route/e2e canary live: line/split -> api-worker, correct/resolve control -> api-owner; e2e create 00388 su api-worker, line/split 200 su api-worker newLine line_0002 revision 2, sync 200 su api-worker revision 3, readback 1 tentativo; report logs/order-worker-sync-e2e-canary-ordersynce2e_line_split_mp4ax_20260705T030512/REPORT.md
MP-4ax health: frontend/owner/realtime/worker health 200 post-canary
MP-4ay correct/resolve retired-route audit: POST /api/integration/orders/correct/resolve e' hard-disabled con 410 ORDER_CORRECTION_APPROVAL_DISABLED prima di readJsonBody; audit ora la marca disabledForOrderWorker e la esclude dal backlog/GO attivo
MP-4ay audit: totale route order-workflow 14, attive per order-worker 13, disabled 1, ready 8, blocked 5; write-primary residuo 5 route; correct/resolve non compare piu nei batch consigliati
MP-4ay check/test: node --check audit OK; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 68/68 pass; audit allowlist create+sync+cancel+comp+correct+barReplacement+lineSplit GO; restart dry-run nuovo preset OK
MP-4ay live: nessun restart necessario, runtime invariato; health live frontend/owner/realtime/worker 200; PID invariati MP-4ax
MP-4az transfer/request write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY (anche da BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY), read-model relazionale preferito, CAS su expectedRevision/currentRevision/revision e incremento revision/currentRevision prima del mirror app-state
MP-4az transfer/request ordering: la richiesta trasferimento viene scritta nel primary relazionale prima di queueIntegrationNotification; su conflitto 409 REVISION_CONFLICT senza mirror app-state
MP-4az audit: transfer/request ora ha writePrimaryFlags e test, writePrimaryCovered 9, write-primary residuo 4 route; resta NO-GO per locks-handoff e notifications, non entra ancora in allowlist worker
MP-4az check/test: node --check server/audit OK; bash -n restart OK; relational-orders-transfer-request-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 69/69 pass; phase-p-validation-preflight 9/9 pass; server.js 38796 righe
MP-4az live: riavviato stesso profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 106175, realtime PID 106202, api-worker PID 106228, frontend PID 106253; LAN https://192.168.1.182:5280/mobile/
MP-4az regression live: create+lineSplit+sync ancora tutto su api-worker, workflow delivered, report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_request_mp4az_regression_20260705T031628/REPORT.md; health frontend/owner/realtime/worker 200
MP-4ba transfer/resolve write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY (anche da BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY), read-model relazionale preferito, CAS su expectedRevision/currentRevision/revision e incremento revision/currentRevision prima del mirror app-state
MP-4ba transfer/resolve ordering: approvazione/negazione trasferimento scritta nel primary relazionale prima di queueIntegrationNotification; su conflitto 409 REVISION_CONFLICT senza risolvere il pendingAuthRequest nel mirror app-state
MP-4ba audit: transfer/resolve ora ha writePrimaryFlags e test, writePrimaryCovered 10, write-primary residuo 3 route; resta NO-GO per audit-permissions e notifications, non entra ancora in allowlist worker
MP-4ba check/test: node --check server/audit OK; bash -n restart OK; relational-orders-transfer-resolve-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 70/70 pass; phase-p-validation-preflight 9/9 pass; server.js 38790 righe
MP-4ba live: riavviato stesso profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 107525, realtime PID 107552, api-worker PID 107578, frontend PID 107603; LAN https://192.168.1.182:5280/mobile/
MP-4ba regression live: create+lineSplit+sync ancora tutto su api-worker, workflow delivered, report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_resolve_mp4ba_regression_20260705T032208/REPORT.md; health frontend/owner/realtime/worker 200
MP-4bb price-override write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY (anche da BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY), read-model relazionale preferito, CAS su expectedRevision/currentRevision/revision e incremento revision/currentRevision prima del mirror app-state
MP-4bb price-override ordering: override prezzo riga scritto nel primary relazionale prima di mirror app-state e financial-sync; su conflitto 409 REVISION_CONFLICT senza aggiornare il mirror app-state
MP-4bb audit: price-override ora ha writePrimaryFlags e test, writePrimaryCovered 11, write-primary residuo 2 route; resta NO-GO per audit-permissions e financial-sync, non entra ancora in allowlist worker
MP-4bb check/test: node --check server/audit OK; bash -n restart OK; relational-orders-price-override-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 71/71 pass; phase-p-validation-preflight 9/9 pass; server.js 38796 righe
MP-4bb live: riavviato stesso profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 109470, realtime PID 109497, api-worker PID 109523, frontend PID 109550; LAN https://192.168.1.182:5280/mobile/
MP-4bb regression live: create+lineSplit+sync ancora tutto su api-worker, workflow delivered, report logs/order-worker-sync-e2e-canary-ordersynce2e_price_override_mp4bb_regression_20260705T032935/REPORT.md; health frontend/owner/realtime/worker 200
MP-4bc transfer/force write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY (anche da BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY), read-model relazionale preferito, CAS su expectedRevision/currentRevision/revision e incremento revision/currentRevision prima del mirror app-state
MP-4bc transfer/force ordering: forzatura trasferimento scritta nel primary relazionale prima del mirror app-state; su conflitto 409 REVISION_CONFLICT senza applicare manual_transfer nel mirror
MP-4bc audit: transfer/force ora ha writePrimaryFlags e test, writePrimaryCovered 12, write-primary residuo 1 route; resta NO-GO per audit-permissions, locks-handoff e notifications, non entra ancora in allowlist worker
MP-4bc check/test: node --check server/audit OK; bash -n restart OK; relational-orders-transfer-force-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 72/72 pass; phase-p-validation-preflight 9/9 pass; server.js 38798 righe
MP-4bc live: riavviato stesso profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 111510, realtime PID 111536, api-worker PID 111561, frontend PID 111589; LAN https://192.168.1.182:5280/mobile/
MP-4bc regression live: create+lineSplit+sync ancora tutto su api-worker, workflow delivered, report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_force_mp4bc_regression_20260705T033645/REPORT.md; health frontend/owner/realtime/worker 200
MP-4bd storno write-primary: aggiunto BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY (anche da BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY); il handler condiviso comp/storno seleziona il flag STORNO solo per /api/integration/orders/storno
MP-4bd storno CAS/read-model: /storno legge il read-model relazionale quando il flag e attivo, usa expectedRevision/currentRevision/revision e scrive il primary prima del mirror app-state; /comp resta sul percorso gia validato e il test I4 ora abilita anche sync write-primary come prerequisito reale
MP-4bd audit: storno ora ha writePrimaryFlags e test, writePrimaryCovered 13/13 route attive, write-primary residuo 0; resta NO-GO per fiscal-payments e financial-sync, non entra ancora in allowlist worker
MP-4bd check/test: node --check server/audit OK; bash -n restart OK; relational-orders-storno-write-primary 1/1 pass; relational-orders-comp-write-primary 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 73/73 pass; phase-p-validation-preflight 9/9 pass; server.js 38798 righe
MP-4bd live: riavviato stesso profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 113749, realtime PID 113776, api-worker PID 113802, frontend PID 113828; LAN https://192.168.1.182:5280/mobile/
MP-4bd regression live: create+lineSplit+sync ancora tutto su api-worker, workflow delivered, report logs/order-worker-sync-e2e-canary-ordersynce2e_storno_mp4bd_regression_20260705T034551/REPORT.md; health frontend/owner/realtime/worker 200
MP-4be transfer notifications outbox: transfer/request pubblica transfer_request via event_outbox dopo il mirror mirato ordine+notifica; transfer/resolve pubblica transfer_approved/transfer_denied via event_outbox dopo il mirror mirato, entrambi con requireOutbox legato a write-primary + EVENT_OUTBOX_ENABLED
MP-4be audit: rimosso il blocker notifications da transfer/request e transfer/resolve; notifications resta solo su transfer/force, writePrimaryCovered 13/13, readyForOrderWorker 8/13 attive, globale ancora NO-GO per audit-permissions, financial-sync, locks-handoff, fiscal-payments e notifications residuo
MP-4be check/test: node --check server OK; server.js 38799 righe; relational-orders-transfer-notification-outbox 1/1 pass; order-workflow-externalization-audit 7/7 pass; route-policy-architecture 74/74 pass; phase-p-validation-preflight 9/9 pass; audit allowlist create+sync+cancel+comp+correct+barReplacement+lineSplit GO
MP-4be live: riavviato stesso profilo create+sync+cancel+comp+correct+barReplacement+lineSplit con PRINTING_ENABLED=0; owner PID 115765, realtime PID 115792, api-worker PID 115817, frontend PID 115848; LAN https://192.168.1.182:5280/mobile/
MP-4be regression live: create+lineSplit+sync ancora tutto su api-worker, workflow delivered, report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_notifications_mp4be_regression_20260705T035330/REPORT.md; health frontend/owner/realtime/worker 200
MP-4bf transfer/resolve audit: approvazione/negazione registrata come order_event relazionale deterministico (id ${orderId}:order.transfer_resolved:${revision}) dentro la stessa transazione CAS del write-primary, idempotente via INSERT OR IGNORE + mergeOrderEvents; nessun appendAuditEvent app-state; builder buildOrderTransferResolutionRelationalEvents in modules/integration/relational-order-events.js
MP-4bf permessi cross-process: approve_room_change gia deterministico via route-policy con forceReload su api-worker e pendingAuthRequest letto dal read-model relazionale; evidenza e2e con mirror app-state mancante e resolve servito dal relazionale
MP-4bf audit: rimosso il blocker audit-permissions da transfer/resolve; readyForOrderWorker 9/13 attive; audit-permissions residuo su price-override e transfer/force; allowlist singola transfer/resolve GO; allowlist 8 route correnti ancora GO; globale resta NO-GO per 4 route
MP-4bf check/test: node --check server/module/audit OK; server.js 38799 righe; relational-orders-transfer-resolve-audit-events 5/5 pass (approve exactly-once + retry 409 senza duplicati, deny, 403/409 zero scritture, bootstrap mirror-mancante, id distinti su risoluzioni successive); relational-orders-transfer-resolve-write-primary 1/1; relational-orders-transfer-notification-outbox 1/1; order-workflow-externalization-audit 7/7; route-policy-architecture 75/75; architecture-line-budget 1/1; phase-p-validation-preflight 9/9
MP-4bf regression live pre-preset: profilo ..._LINE_SPLIT_CANARY riavviato (owner 118806, realtime 118833, worker 118858, frontend 118884), create+lineSplit+sync su api-worker, workflow delivered; report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_resolve_audit_mp4bf_regression_20260705T044556/REPORT.md
MP-4bf preset: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_CANARY=1 con allowlist default a 9 route (8 correnti + POST /api/integration/orders/transfer/resolve); bash -n OK; dry-run OK con gate audit route-scoped GO
MP-4bf preflight/canary e2e: aggiunti al preflight probe order-worker-transfer-resolve-allowlist (control transfer/request), allowlist audit a 9 route, restart preset dry-run/restart e voce e2e order-worker-create-transfer-resolve-sync-e2e; order-worker-sync-e2e-canary supporta CANARY_REQUIRE_TRANSFER_RESOLVE=1 (request via owner -> resolve via worker, revisione e stazione propagate a sync); phase-p-validation-preflight 9/9
MP-4bf live: profilo transfer-resolve avviato con PRINTING_ENABLED=0; owner PID 6333, realtime PID 6363, api-worker PID 6391, frontend PID 6419; health 5280/5281/5282/5283 tutti 200; LAN https://192.168.1.38:5280/mobile/ (attenzione: IP rete cambiato da 192.168.1.182)
MP-4bf route canary live: transfer/resolve -> api-worker con direct allowed, transfer/request control -> api-owner con direct blocked; report logs/order-worker-route-canary-orderroute_20260705T121309/REPORT.md
MP-4bf e2e canary live: create 00396 su api-worker, lineSplit su api-worker, transfer/request su api-owner, transfer/resolve su api-worker (revision 4, station COCKTAIL), sync ready/delivered su api-worker, exit 0; audit event live verificato nel relazionale: id 00396:order.transfer_resolved:4, actor u_lorenzo, payload approved/from/to/mode completo; report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_resolve_mp4bf_20260705T141327/REPORT.md
MP-4bg transfer/request locks-handoff chiuso: blocker verificato stantio sul codice (nessuna lettura/scrittura di lock, stationStates o work lock tavolo nel handler; handoff pendingAuthRequest gia nel raw_json relazionale con CAS che serializza le request concorrenti); evidenza e2e relational-orders-transfer-request-handoff 4/4 (bootstrap mirror-mancante, due request parallele -> un 200 e un 409 senza doppia pending, 409 stantio zero scritture, sequence stantia senza collisioni post-riavvio)
MP-4bg audit: rimosso blocker locks-handoff da transfer/request; readyForOrderWorker 10/13 attive; locks-handoff residuo solo su transfer/force; focus esternalizzazione ora audit-permissions/financial-sync/fiscal-payments; batch-1 con transfer/request prima di transfer/resolve (tie score 155)
MP-4bg check/test: node --check audit/moduli OK; route-policy-architecture 76/76 (nuovo test statico: request senza dipendenze lock/owner, primary prima della notifica); order-workflow-externalization-audit 7/7; phase-p-validation-preflight 9/9; allowlist 10 route GO e allowlist 9 route ancora GO; server.js 38799 righe invariato
MP-4bg preset/preflight: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_CANARY=1 (allowlist 10 route); probe order-worker-transfer-request-allowlist con control transfer/force; control del probe transfer/resolve migrato a transfer/force; e2e transfer del preflight ora attende request su api-worker
MP-4bg bug trovato dal canary live (sequence clobber cross-process): il flush notifiche dell'owner scrive l'objectField sequence intero e ha riportato sequence.order a 396 dopo che il worker aveva allocato 00396 -> create successiva 500 "Ordine relazionale gia' esistente" (guardia relazionale corretta); fix: il merge di idratazione avanza sempre sequence.order oltre MAX(id) del relazionale (getMaxOrderId in orders.repo.js, guardia in order-startup-reconcile.js, attiva su tutti i ruoli); fix strutturale futuro: split del record sequence per contatore
MP-4bg live: profilo transfer-request avviato con PRINTING_ENABLED=0; owner PID 10301, realtime PID 10339, api-worker PID 10368, frontend PID 10397; health 5280/5281/5282/5283 tutti 200; probe request -> api-worker con direct allowed, force control -> api-owner con direct blocked (report logs/order-worker-route-canary-orderroute_20260705T123828); LAN https://192.168.1.182:5280/mobile/
MP-4bg e2e canary live: create 00397 su api-worker (prova del fix sequence), lineSplit su api-worker, transfer/request su api-worker, transfer/resolve su api-worker (revision 4), sync ready/delivered su api-worker, exit 0; report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_request_mp4bg_retry_20260705T213447/REPORT.md
MP-4bh price-override audit+financial chiusi: audit override persistito come order_event relazionale deterministico (id ${orderId}:${lineId}:order.line_price_overridden:${revision}) fuso nel grafo ordine prima del CAS write-primary; appendAuditEvent app-state CONSERVATO deliberatamente (consumato da reports.handlers per report.orderEvents); financial-sync ora da snapshot ordini relazionale post-write-primary con guard revision su table_state (stessa catena di cancel/comp/correct, label orders.priceOverride.relationalFinancialSnapshotRead)
MP-4bh nota semantica financial: il dovuto tavolo matura alla consegna (ordine waiting -> pendingBills vuote, total_due_cents 0 e' corretto); l'e2e financial consegna l'ordine prima dell'override e verifica 130 -> 400 centesimi con revision guard avanzata
MP-4bh audit: rimossi blocker audit-permissions e financial-sync da price-override; readyForOrderWorker 11/13 attive; residui: transfer/force (audit-permissions+locks-handoff+notifications) e storno (fiscal-payments+financial-sync); tutte le dimensioni residue a 1 route
MP-4bh check/test: node --check server/moduli/audit OK; server.js 38793 righe (sotto budget); relational-orders-price-override-audit-financial 3/3 (evento exactly-once + retry 409, table_state 400 cents con guard, 409 stantio zero scritture); relational-orders-price-override-write-primary 1/1; order-workflow-externalization-audit 7/7; route-policy-architecture 77/77; phase-p-validation-preflight 9/9; allowlist 11 route GO
MP-4bh preset/preflight/canary: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_CANARY=1 (allowlist 11 route); probe order-worker-price-override-allowlist (control transfer/force); order-worker-sync-e2e-canary supporta CANARY_REQUIRE_PRICE_OVERRIDE=1 (lock tavolo, override con expectedRevision, ordine propagato agli stage successivi); voce e2e preflight dedicata
MP-4bh live: profilo price-override avviato con PRINTING_ENABLED=0; owner PID 17866, realtime PID 17895, api-worker PID 17921, frontend PID 17947; health 5280/5281/5282/5283 tutti 200; probe price-override -> api-worker con direct allowed, force control -> api-owner con direct blocked (report logs/order-worker-route-canary-orderroute_20260705T234155); LAN https://192.168.1.182:5280/mobile/
MP-4bh e2e canary live: create 00398 su api-worker, lineSplit su api-worker, price-override su api-worker (evento live 00398:line_0002:order.line_price_overridden:3, actor u_lorenzo), transfer/request e transfer/resolve su api-worker (evento 00398:order.transfer_resolved:5), sync ready/delivered su api-worker, exit 0; report logs/order-worker-sync-e2e-canary-ordersynce2e_price_override_mp4bh_20260706T014156/REPORT.md
MP-4bi transfer/force audit+outbox+locks chiusi: la forzatura trasferimento registra `order.transfer_forced` come order_event relazionale deterministico dentro la stessa transazione CAS, pubblica `transfer_forced` via event_outbox quando write-primary+outbox sono attivi e il handler e' verificato senza dipendenze da lock/station owner-bound.
MP-4bi audit: rimossi i blocker audit-permissions, locks-handoff e notifications da transfer/force; readyForOrderWorker 12/13 attive; residuo unico `POST /api/integration/orders/storno` con financial-sync e fiscal-payments.
MP-4bi check/test: node --check server/moduli/canary/preflight/audit OK; bash -n restart OK; relational-orders-transfer-force-audit-outbox 1/1; relational-orders-transfer-force-write-primary 1/1; order-workflow-externalization-audit 7/7; route-policy-architecture 78/78; phase-p-validation-preflight 9/9; server.js 38795 righe; audit allowlist 12 route GO.
MP-4bi preset/preflight/canary: aggiunto BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_CANARY=1 con allowlist a 12 route; preflight include probe transfer/force con control storno e e2e completo create+split+priceOverride+transferRequest+transferResolve+transferForce+sync.
MP-4bi live: profilo transfer-force avviato con PRINTING_ENABLED=0; owner PID 21786, realtime PID 21813, api-worker PID 21840, frontend PID 21870; health 5280/5281/5282/5283 tutti 200; LAN corrente https://172.20.10.2:5280/mobile/ (il vecchio 192.168.0.28 non risponde piu' su questa rete).
MP-4bi route/e2e canary live: transfer/force -> api-worker con direct allowed e storno control -> api-owner/direct blocked (report logs/order-worker-route-canary-orderroute_20260706T001720); e2e create+lineSplit+priceOverride+transferRequest+transferResolve+transferForce+sync tutto su api-worker, workflow delivered, exit 0 (report logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_force_mp4bi_20260706T021720/REPORT.md).
MP-4bj storno payment-effects contract: aggiunto e2e `relational-orders-storno-payment-effects.e2e.test.mjs` per cash pagato, POS parziale con supersede/riaddebito e stale conflict 409 senza side effect; il test ha trovato ordine relazionale economicamente stale dopo pagamento.
MP-4bj fix: i write-primary pagamenti tavolo/free-split sincronizzano nella stessa transazione relazionale anche lo stato economico degli ordini toccati, via `modules/payments/relational-payment-order-sync.js`, CAS su orders.revision e aggiornamento app-state alla revisione risultante; storno ora calcola paymentStorno/void/recharge dal read-model relazionale aggiornato.
MP-4bj check/test: node --check server/modulo/index OK; relational-orders-storno-payment-effects 3/3; relational-orders-storno-write-primary 1/1; relational-payments-table-write-primary 4/4; relational-payments-free-split-write-primary 4/4; route-policy-architecture 78/78; server.js 38799 righe.
MP-4bk storno payment-effects extraction: estratto il blocco pagamento/fiscale/stampa storno in `modules/integration/order-storno-payment-effects.js` con factory a dipendenze esplicite; il server resta orchestratore e conserva gli stessi entrypoint (`resolveOrderCompPaymentReferences`, `buildOrderCompRefundPlan`, `buildPaymentReferencesFromRefundPlan`, `applyOrderCompPaymentAdjustmentsForRefundPlan`, `appendPaymentStornoPrintJobToDb`) via destructuring dal modulo.
MP-4bk semantica: nessuna allowlist nuova e nessun cambio runtime; il modulo puo' ancora applicare patch su `db`, ma restituisce anche `mutationSummary` per superseded/created ids, utile per audit e test successivi. Step 3 resta financial sync/fiscal-payment write-primary prima di dichiarare storno worker-ready.
MP-4bk check/test: node --check server/modulo/index OK; relational-orders-storno-payment-effects 3/3; relational-orders-storno-write-primary 1/1; relational-orders-comp-write-primary 1/1; relational-payments-table-write-primary 4/4; relational-payments-free-split-write-primary 4/4; route-policy-architecture 78/78; server.js 38047 righe.
MP-4bl storno financial-sync: il handler condiviso comp/storno usa `orderCompMetricPrefix` per esporre `orders.storno.relationalFinancialSnapshotRead` e `orders.storno.appStateWrite`; lo storno conserva la catena syncRelationalOrderPrimary -> snapshot ordini relazionale -> financial sync -> guard table_state -> persist table_states.
MP-4bl audit: rimosso il blocker `financial-sync` da orders/storno; resta solo `fiscal-payments`, quindi la route non entra ancora in allowlist worker. Prossima azione: modellare pagamenti/fiscale storno su intent persistenti condivisi.
MP-4bl check/test: route-policy-architecture 79/79; order-workflow-externalization-audit 7/7; phase-p-validation-preflight 9/9; relational-orders-storno-payment-effects 3/3; relational-orders-storno-write-primary 1/1; relational-orders-comp-write-primary 1/1.
MP-4bm storno fiscal-payment intents: aggiunta write dedicata `writeOrderStornoFiscalPaymentIntentDb` con label `orders.storno.fiscalPaymentIntentWrite`, domini `payments/paymentContainers/paymentParts/paymentTransactions/paymentProviderTransactions/fiscalReceipts/fiscalEvents/printSpoolJobs/auditEvents` e chiamata prima del mirror `writeIntegrationOrderSyncDb` quando lo storno pagato produce rimborso, void POS, riaddebito o ticket `payment_storno`.
MP-4bm audit: rimosso il blocker residuo `fiscal-payments`; audit globale `orderWorkersGoNoGo=go`, `readyForOrderWorker=13`, `blockedForOrderWorker=0`, `blockerDimensionSummary=[]`. La route `correct/resolve` resta disabilitata e fuori dal conteggio attivo.
MP-4bm check/test: node --check server/audit OK; route-policy-architecture 80/80; order-workflow-externalization-audit 7/7; phase-p-validation-preflight 9/9; relational-orders-storno-payment-effects 3/3; relational-orders-storno-write-primary 1/1; relational-orders-comp-write-primary 1/1; architecture-line-budget 1/1.
MP-4bn preset finale storno: aggiunto `BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1` in `tools/restart-cassav4-linux.sh`, con allowlist a 13 route compreso `POST /api/integration/orders/storno`.
MP-4bn preflight/canary: `phase-p-validation-preflight.mjs` include route-canary `order-worker-storno-allowlist` (target storno, control `POST /api/payments/table`), e2e finale `order-worker-create-transfer-force-storno-sync-e2e` con `CANARY_REQUIRE_STORNO=1`, sync delivered, pagamento cash virtuale e `CANARY_EXPECT_STORNO_PROXY_ROLE=api-worker`.
MP-4bn check/test: node --check e2e/preflight OK; bash -n restart OK; phase-p-validation-preflight 10/10; order-workflow-externalization-audit 7/7; route-policy-architecture 80/80; allowlist audit 13 route GO; architecture-line-budget 1/1; relational-orders-storno-payment-effects 3/3.
MP-4bo bug live canary: il primo e2e finale ha trovato che `payments/free-split` su api-owner non vedeva l'ordine appena creato dal worker e rispondeva 404 `Comanda non trovata`. Fix: `payments.handlers.js` idrata l'ordine esplicito dal read-model relazionale via `readRelationalPaymentOrderById` quando manca dalla cache owner, prima di `syncPosTableFinancialsFromIntegrationOrders`, `validateFreeSplitAuthoritativePayable` e financial sync.
MP-4bo canary script: il pagamento pre-storno dell'e2e finale usa `POST /api/payments/free-split` cash con `issueFiscal=false` sull'ordine consegnato, invece di dipendere dai `pendingBills` tavolo; il report ora mostra route e proxy del pagamento pre-storno.
MP-4bo live: profilo finale 13 route avviato con `PRINTING_ENABLED=0`; owner PID 18651, realtime PID 18677, api-worker PID 18703, frontend PID 18744; health 5280/5281/5282/5283 tutti 200; LAN https://192.168.0.74:5280/mobile/.
MP-4bo route/e2e canary live: storno -> api-worker con direct allowed e payments/table control -> api-owner/direct blocked (report `logs/order-worker-route-canary-orderroute_20260706T085707`); e2e finale create+lineSplit+priceOverride+transferRequest+transferResolve+transferForce+sync+pre-storno payment+storno verde, ordine 00402, pagamento pre-storno su `/api/payments/free-split` via api-owner, storno su api-worker revision 8, exit 0 (report `logs/order-worker-sync-e2e-canary-ordersynce2e_20260706T085715`).
MP-4bo check/test: node --check server/payments/e2e OK; relational-orders-storno-payment-effects 3/3; relational-payments-free-split-write-primary 4/4; route-policy-architecture 80/80; phase-p-validation-preflight 10/10; order-workflow-externalization-audit 7/7; architecture-line-budget 1/1.
```

## Stato

Default runtime invariato quando non si impostano flag. Stato live attuale: profilo canary finale
create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve+transferRequest+priceOverride+transferForce+storno
attivo con owner 5281, realtime-gateway 5282, api-worker 5283 e frontend HTTPS 5280. Allowlist worker
a 13 route nel profilo live MP-4bo, con route/e2e canary storno verdi e stampa/fiscale reali non usati (`PRINTING_ENABLED=0`).
PID live MP-4bo: owner 18651, realtime-gateway 18677, api-worker 18703, frontend 18744.
LAN attuale: https://192.168.0.74:5280/mobile/ (attenzione: l'IP cambia a seconda della rete).

## MP-4bp - session coherency sotto concorrenza

Aggiornamento 2026-07-06: il ramp successivo al profilo finale ha evidenziato
che il problema residuo non era piu' la copertura route, ma la coerenza delle
sessioni fra processi. In concorrenza, login e write `integration` potevano
arrivare con snapshot locali diversi e cancellare sessioni valide nel repository
split condiviso.

Regola topologica aggiornata:

- il login puo' fare sync del dominio sessioni solo in modalita' additiva
  (`deleteMissing:false`);
- i write `integration`/station-only non devono sincronizzare il dominio
  sessioni;
- uno snapshot locale di un singolo processo non puo' essere usato per potare
  sessioni globali create da altri processi;
- eventuale pruning sessioni deve essere una responsabilita' esplicita, non un
  side effect di order/station writes.

Evidenza live: dopo il fix `mysql-sessions` + `device-status` e il skip sessioni
per sync `integration`-only, il batch
`logs/mp4bp_load5_sessionskipfix_20260706T113901` passa 5/5 senza `401`, con le
13 route order workflow servite da `api-worker` e pagamenti owner invariati.

Resta aperto il gate capacity: le latenze sono ancora troppo alte per dichiarare
verde il load-50. Il prossimo passo non e' aggiungere altre route alla allowlist,
ma misurare e ridurre il costo sincrono per operazione oppure introdurre un
worker pool controllato con stato condiviso relazionale.

## MP-4bq - route lane e sessioni postazione

Aggiornamento live 2026-07-06:

- le transfer route erano nella allowlist multiprocess ma non nella
  `ORDER_WORKFLOW_FAST_LANE_PATHS`; ora `transfer/request`,
  `transfer/resolve`, `transfer/force`, `integration replacement/bar-charge` e
  `orders replacement/bar-charge` entrano nella order lane;
- `orders/sync` non rivalida piu' la sessione sul cache fast-lane quando la
  route policy ha gia' prodotto `req.__authContext`;
- login e auth path usano refresh esplicito delle sessioni esterne, mentre la
  write del login e' additiva (`deleteMissing:false`) e limitata a
  `sessions/users/auditEvents`.

Evidenza:

- test mirati verdi: route-policy/auth-session/mysql-session split 98/98;
- smoke live `logs/mp4bp_load5_loginrefresh_20260706T123923` verde 5/5, con
  tutte le route order workflow attese su `api-worker`, zero `401` e 5/5
  sessioni `postazione` visibili in `app_state_sessions`.

Nota di capacity: il gate prestazionale rimane rosso. Anche dopo il routing
corretto, l'api-worker resta CPU-bound e le route order workflow pesanti
mostrano durate 15-26s nel batch da 5. La prossima fase deve quindi ridurre il
costo CPU per handler o passare a un pool di worker coordinato dal relazionale.

## MP-4br - refresh scoped al posto della reidratazione completa per-request

Aggiornamento 2026-07-06 (pomeriggio): individuata e rimossa la causa dominante
del costo per-request sull'api-worker. Diagnosi: l'auth di OGNI route a permessi
sul worker faceva `readDb({forceReload:true})` -> rilettura completa del row
`app_state` MySQL + reidratazione di TUTTI i domini split (audit a migliaia di
righe, ordini+indice, sessioni, notifiche, lock, print spool, device status,
payments) a ogni singola richiesta; in piu' il pre-lane di orders/sync faceva un
secondo forceReload identico. Misura di conferma: un flusso SINGOLO senza
concorrenza costava 3.3-6.6s per mutazione.

Fix (due punti):

- `resolveAuthenticatedRequestContext`: su api-worker niente piu' forceReload;
  refresh scoped `{ refreshExternalizedSessions, refreshExternalizedTableLocks,
  refreshExternalizedIntegrationSequence }` — tre letture piccole dalla fonte
  MySQL condivisa (sessioni split, work lock tavolo via listTableWorkLocks con
  merge in-place, record sequence via readObjectEntry con merge a MAX per non
  regredire i contatori locali e non riaprire la classe sequence-clobber).
  Il forceReload resta solo per orders/sync sull'owner (ramo legacy).
- pre-lane duplicate sync: con write-primary relazionale l'ordine arriva da
  readRelationalOrderById e la sessione e' gia' validata dalla policy -> solo
  refresh sessioni; forceReload conservato nel ramo legacy app-state.

Contratto: le 13 route order-workflow sul worker leggono ordini dal read-model
relazionale (audit MP-3/MP-4), quindi il mirror locale non deve piu' essere
fresco per-request; cio' che DEVE essere fresco per auth e guard e'
sessioni+lock+sequence, ora rinfrescati in modo scoped. Limite noto: utenti
creati dopo il boot del worker non sono visibili sul worker finche' non avviene
una reidratazione naturale (creazione utenti = operazione admin rara).

Evidenza:

- test: route-policy-architecture 83/83 (pin aggiornato + 2 assert nuove sui
  refresher scoped), terminal-duplicate-sync-prelane 2/2 + 2/2, auth-session
  14/14, mysql-sessions-split 1/1, app-state-repository 41/41, orders-flow 8/8,
  relational-orders-async-ack 1/1, audit 7/7, preflight 10/10; server.js 38192
  righe (ampio margine budget dopo i refactor).
- flusso singolo live (prima -> dopo): create 3891 -> 483ms, lineSplit 3709 ->
  112ms, priceOverride 3278 -> 223ms, sync 6576 -> 318ms.
- batch load5 completo (create+split+priceOverride+trReq+trRes+trForce+storno+
  sync, tavoli distinti room_terrazza_t04..t08): 5/5 exit 0, zero errori, tutte
  le mutazioni tra 60ms e 1.4s contro i 13-42s del batch MP-4bq — circa 20-40x.
  Report: logs/mp4br_load5_scoped_20260706T151139_d1..d5 e relative dir canary.
  Nota operativa batch: con 5 flussi paralleli assegnare tavoli distinti via
  CANARY_TABLE_ID, altrimenti i 409 da work-lock tavolo sono attesi.

Il gate capacity sul profilo multi-processo passa quindi da "CPU-bound gia' a 5
flussi" a margine reale; il prossimo passo di misura e' il ramp load-25/load-50
multi-processo con il loadtest harness per rivalutare il gate P3 su questa
topologia.

## MP-4bs - loadtest harness multi-processo e ramp load-25/50

Aggiornamento 2026-07-06 (sera): il loadtest harness supporta ora la topologia
multi-processo con `LOADTEST_MULTIPROCESS=1` (opt-in, default invariato):

- avvia owner (5291, api-owner), realtime-gateway (5292), api-worker (5293) con
  le stesse tabelle MySQL per-run, relational sqlite per-run, outbox e allowlist
  13 route (audit GO); i processi non-owner non importano il seed;
- il proxy frontend (5290) riceve gli origins realtime/worker e TUTTI i flag
  prerequisito (nota bene: il proxy valuta `getOrderMutationScalePrerequisites`
  sul PROPRIO env — dimenticare `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS` fa
  ricadere silenziosamente tutte le mutazioni sull'owner, come successo al primo
  run);
- il traffico device passa dal proxy (`deviceApiBaseUrl`); le runtime metrics del
  report vengono dal WORKER (dove vive l'order workflow), con reset su entrambi;
- monitor CPU/RSS esteso ai 3 backend.

Fix reale trovato dal ramp: la ristampa (`POST /api/integration/print`, route
owner-only) faceva 404 sugli ordini appena creati sul worker (mirror owner in
ritardo). Applicato il bootstrap relazionale pre-404 (pattern MP-4ae di cancel)
in `handleIntegrationPrint`; route-policy 83/83 invariati.

Risultati (12 postazioni, 12 op/device, fiscale non reale, GUI 0):

- smoke 12: 0 failure, create p95 1565ms;
- load-25: 0 failure, create p95 5866ms, sync.delivered p95 5751ms, heartbeat
  p95 877ms; CPU: worker 86 media (saturo), owner 47, realtime 0;
- load-50: 0 failure, 744 business ops/102s, create p95 9526ms, sync.delivered
  p95 10113ms, heartbeat p95 1231ms; CPU: worker 86 media / max 138 (saturo),
  owner 47, realtime 0. Confronto baseline mono-processo canary8_50: create p95
  11016ms.

Lettura: la topologia regge il load-50 senza errori e l'owner non e' piu' il
collo (heartbeat ~1s vs 24s dei vecchi run); il limite e' ora la capacita' di
UN SOLO api-worker che serve tutte le 13 route ordine. Il gate P3 (<500ms p95)
resta rosso. Prossimo passo con il miglior rapporto guadagno/sforzo: **pool di
N api-worker** dietro il proxy (estendere `BACKEND_API_WORKER_ORIGIN` a lista
con bilanciamento nel multiplexer + N processi worker nel restart script e nel
harness); in parallelo, profilare il costo CPU per-op sul worker per abbassare
il pavimento per-operazione.

Report: logs/loadtest-mp_p3_multiproc_smoke_12, logs/loadtest-mp_p3_multiproc_load25_v3,
logs/loadtest-mp_p3_multiproc_load50 (v1/v2 del load-25 documentano il bug env
proxy e i 404 ristampa).
