# Fase P3 - Order async ACK (write relazionale prima dell'ACK, mirror MySQL asincrono)

Data: 2026-07-04

## Obiettivo

Attuare la decisione architetturale della roadmap interinale P3 ("ACK dopo write relazionale"):
rispondere al client dopo mutazione in-memory + commit relazionale SQLite durevole (write-primary
Fase I4, gia' esistente dietro flag), spostando il mirror MySQL app-state (400-900ms amplificati)
fuori dal percorso di risposta in un flush asincrono coalescato. Tutto dietro flag env, default OFF.

## Interventi

### Flag (default OFF, rollback con una variabile)

- `BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1` (alias `ORDERS_ASYNC_APPSTATE_FLUSH=1`) abilita il defer
  per create+sync; per-azione: `BACKEND_ORDERS_CREATE_ASYNC_ACK` / `BACKEND_ORDERS_SYNC_ASYNC_ACK`.
- L'ACK asincrono e' **vincolato** al write-primary relazionale corrispondente
  (`RELATIONAL_ORDERS_CREATE/SYNC_WRITE_PRIMARY`): se richiesto senza prerequisito viene
  auto-disabilitato con warn all'avvio (nessun hard-fail).
- Knob: `ORDERS_ASYNC_FLUSH_INTERVAL_MS` (25), `ORDERS_ASYNC_FLUSH_MAX_PENDING_ORDERS` (1000,
  oltre: fallback sincrono con contatore), `ORDERS_ASYNC_FLUSH_RETRY_BASE_MS`/`_MAX_MS` (250/5000),
  `ORDERS_STARTUP_RECONCILE_MARGIN_MS` (6h) / `_FALLBACK_WINDOW_MS` (48h).

### Percorso richiesta

- Ramo `defer` unico in `writeIntegrationOrderSyncDb` (server.js): con flag attivo la scrittura
  mirror viene accodata (`orderAsyncAppStateFlushQueue.tryDefer`) e l'handler risponde subito;
  metrica `orders.create|sync.appStateWrite.deferred`.
- Call-site: `defer: ORDERS_CREATE_ASYNC_ACK` (create), `defer: ORDERS_SYNC_ASYNC_ACK` (sync).
  Cancel/correct/comp/transfer/split/price-override restano sincroni (V1).
- Nuovo modulo `backend/modules/integration/order-async-appstate-flush.js`: coda coalescante
  per-ID (union orderIds/auditEventIds/notificationIds/fulfillmentHistoryIds/posSettingsTableIds,
  OR dei flag), un batch in volo, retry con backoff esponenziale che **ri-merge lo snapshot fallito**
  (nessun ID perso), label batch `orders.asyncFlush.appStateWrite`. Contatori:
  `ordersAsyncFlushEnqueued/Coalesced/Batches/Retries/BackpressureSync`, gauge
  `ordersAsyncFlushPendingDepth`.
- SIGINT/SIGTERM drenano la coda (timeout 5s) prima delle chiusure.

### Crash-recovery (riconciliazione all'avvio)

- Nuovo modulo `backend/modules/integration/order-startup-reconcile.js`, due fasi:
  1. `mergeRelationalOrdersIntoHydratedState` dentro `hydrateAppStateSplitDomains`: al primo
     `readDb` porta nello stato gli ordini che il relazionale ha (revision maggiore o assenti nel
     mirror). Deve avvenire in idratazione perche' in shadow mode **ogni writeDb esegue
     replaceAllFromAppState**: una scrittura precedente alla riconciliazione cancellerebbe dal
     relazionale gli ordini non ancora mirrorati (bug reale trovato dal test e2e crash-reconcile).
  2. `persistReconciledOrders` post-listen: scrive il mirror per gli ID riconciliati
     (label `orders.startupReconcile.appStateWrite`, contatore `ordersStartupReconciled`).
- Nuovo `listOrdersUpdatedSince(sinceIso)` in `db/relational/orders.repo.js` + migrazione
  `017_orders_updated_at_index.sql` (indice su `orders.updated_at`).

### Shadow sync filtrato (necessario per il carico)

- `afterWrite` ora riceve i domini dirty; `syncAfterAppStateWrite` accetta un contesto con
  `dirtyDomainFilter` + `skipDomains` (mappa trigger in `db/relational/index.js`).
- Solo con async-ACK attivo: sync shadow limitato ai domini alimentati dai dirty della scrittura,
  con skip di `orders` (mantenuto nativo dal write-primary) e `auditEvents` (coperto dallo split
  MySQL `app_state_audit_events` e da `order_events` nativo). Con equivalence domains configurati
  il filtro si disattiva (full sync, semantica invariata). Flag OFF = comportamento identico a prima.

## Verifiche

- `node --check` su server.js, moduli nuovi, orders.repo.js, migrations.js, runtime-metrics.js: OK
- Budget righe server.js: 38.798 / 39.500 (margine 702, vincolo >=700 rispettato)
- Nuovi test:
  - `order-async-appstate-flush.test.mjs`: 5/5 (coalescing, OR flag, retry re-merge, backpressure, drain)
  - `relational-orders-async-ack.e2e.test.mjs`: 1/1 (ACK immediato, relazionale subito, mirror converge)
  - `relational-orders-crash-reconcile.e2e.test.mjs`: 1/1 (SIGKILL dopo ACK, riavvio, ordine ripristinato dal relazionale, revision preservata, sequence avanzata)
- Suite esistenti: route-policy-architecture 47/47 (46+1 nuovo), relational-orders 21/21 (20+1),
  relational-shadow 53/53, relational-equivalence 12/12, app-state-repository 40/40,
  orders-flow.e2e 7/7, orders-payments-invariants 17/17, order-state-machine 17/17,
  relational-orders-create/sync-write-primary.e2e 1/1+1/1, relational-migration-script 6/6,
  runtime-metrics 5/5, architecture-line-budget 1/1.

## Risultati sotto carico

Env comune: `BACKEND_RELATIONAL_ENABLED=1 BACKEND_RELATIONAL_MODE=shadow
BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1 BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1
ORDER_SYNC_FAST_LANE_CONCURRENCY=8 POS_FISCAL_API_BASE_URL=http://127.0.0.1:9` (fiscale non reale).

### Smoke 20 device (12 ops/device)

Run: `phaseP_interinale_p3_order_async_ack_smoke_20c`
- failure 0, coda finale 0/0
- `orders.create.appStateWrite.deferred`: avg 0.05ms (mirror fuori dal percorso risposta)
- flush: 136-146 enqueue coalescati in 33-35 batch, 0 retry, 0 backpressure

### Canary 50 device x2 (confronto con baseline `phaseP_interinale_p3_station_state_entry_canary8_50`)

| Metrica | Baseline | Run1 async ACK | Run2 async ACK |
|---|---:|---:|---:|
| business ops / durata | 744 / 104s | 744 / 119s | 744 / 118s |
| failure | 0 | 0 | 0 |
| order.create p95 | 11016ms | 10278ms | 9556ms |
| order.sync.ready p95 | 11681ms | 13604ms | 9847ms |
| order.correct p95 | 10828ms | 10031ms | 10272ms |
| mirror sul percorso risposta | 500-900ms sincroni | 0.02ms (deferred) | 0.03ms (deferred) |
| flush retries / backpressure | n/a | 0 / 0 | 0 / 0 |
| CPU backend (tick/sec media) | 103 | 103 | ~103 |

Il meccanismo funziona (mirror a costo zero sul percorso richiesta, zero errori, coda che drena),
ma il p95 end-to-end migliora solo del 10-15%.

## Calcolo esplicito di capacita' (Passo 5 roadmap)

**Modello I/O-lane (quello implicito nei passi precedenti) — ora falsificato:**
- capacita' teorica = concorrenza 8 / run medio 0,77s ≈ **10,4 op/s**
- arrivo lane osservato = 351 task / 119s ≈ **2,95 op/s** → margine apparente +250%
- eppure p95 ≈ 10s → il modello a coda I/O non spiega piu' i numeri.

**Modello CPU (quello reale):**
- il processo backend usa **~103 tick/sec medi per tutta la durata** (1 core JS saturo), in modo
  identico nel baseline e nei run async-ACK;
- benchmark isolato: `createOrder` relazionale = **5ms**, `replaceOrderWithRevision` = **0,5ms**;
  sotto carico gli stessi percorsi misurano 197-251ms wall → **~97% del tempo e' accodamento
  sull'event loop**, non lavoro;
- CPU consumata ≈ 1,03 core × 119s ≈ 122,6 CPU-s per 744 business ops ≈ **165ms CPU/op**;
- domanda al tasso osservato ≈ 6,3 op/s × 0,165s ≈ **1,04 core ≈ 104% della capacita'** →
  **margine negativo (~-4%)**: durante il burst la coda cresce per costruzione, qualunque sia il
  modello di scrittura.
- Per p95 < 500ms al burst da 50 device servirebbe utilizzo < ~70% e costo CPU/op < ~55-110ms:
  oggi non raggiungibile in un singolo processo Node.

## Stato gate

Il gate P3 resta **rosso**, ma la diagnosi cambia: il collo non e' (piu') il modello di scrittura.
La scrittura MySQL e' fuori dal percorso di risposta e la durabilita' e' garantita dal relazionale
prima dell'ACK; i 10s di p95 sono **saturazione CPU del singolo thread JS** sotto burst — presente
identica anche nel baseline (103 tick/sec), dove era mascherata dai tempi I/O.

## Prossimo passo consigliato

1. **Non** proseguire con altri fastpath I/O: il margine e' sul lato CPU.
2. Profilare il costo CPU per operazione ordine (sanitize/financial-sync/SSE fan-out/pruning,
   costruzione righe+hash del flush) con `--cpu-prof` sotto il canary 50 e abbattere i top-3.
3. In parallelo valutare la strada strutturale: piu' processi worker (cluster) con il relazionale/
   MySQL come punto di coordinamento — e' la vera "Fase H" per il carico, ora che il modello di
   scrittura non e' piu' il vincolo.
4. Mantenere i flag async-ACK: riducono il costo per operazione (~500-900ms di I/O sincrono in meno),
   eliminano la classe deadlock/retry MySQL dal percorso richiesta e sono prerequisito di qualunque
   soluzione multi-processo.

## Nota Passo 2 roadmap (audit-events split)

`mysql-audit-events-split.repository.js` risulta **gia' agganciato** in server.js (istanza :17449,
fast path `syncOrderAuditEventsFastPath`, hydrate, status log) dietro `MYSQL_SPLIT_AUDIT_EVENTS`,
con guardrail statico in route-policy. La voce "0 riferimenti" della roadmap era stantia:
decisione "(a) completato" de facto; restano opzionali test funzionali dedicati.

## File evidenza

- `logs/loadtest-phaseP_interinale_p3_order_async_ack_smoke_20/REPORT.md` (+ `_20b`, `_20c`)
- `logs/loadtest-phaseP_interinale_p3_order_async_ack_canary8_50_run1/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_async_ack_canary8_50_run2/REPORT.md`
- baseline: `logs/loadtest-phaseP_interinale_p3_station_state_entry_canary8_50/REPORT.md`
