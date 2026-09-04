# Fase P4 - isolamento e coalescing pipeline stampa

Data: 2026-07-11

## Ambito

Step eseguito interamente in locale. Il Raspberry `192.168.1.79` non e' stato
contattato. Stampante TCP e fiscale erano mock su loopback; cassa automatica
disabilitata e I/O non-loopback bloccato dal loadtest.

## Difetti trovati

1. Il profilo multiprocesso impostava `LANE_PRINT=1` e
   `PRINT_LANE_ENABLED=1`, ma non il prerequisito
   `PRINT_SPOOL_SQL_PRIMARY=1`. La lane si disabilitava silenziosamente e
   l'auto-print ricadeva in `dbMutation`.
2. Dopo l'abilitazione SQL-primary, enqueue, claim e completion dello stesso
   job producevano tre mirror legacy distinti. I mirror usavano una sync
   completa del dominio `printSpoolJobs` e saturavano la lane.
3. I nuovi contatori del coalescing non erano pre-registrati in
   `runtime-metrics.js`, quindi venivano ignorati.
4. Anche dopo il coalescing, il batch mirror condivideva la `printLane` con
   l'auto-print autorevole. Un batch lento poteva quindi trattenere tutte le
   stampe degli ordini pur essendo solo un mirror di compatibilita'.
5. Dopo la separazione, le due API worker eseguivano comunque il mirror MySQL e
   il worker stampa, nonostante il log dichiarasse i job owner disattivati.
6. L'invio TCP attendeva 180ms fissi dopo ogni write, imponendo un tetto di
   circa 5,5 stampe/s anche con una stampante immediatamente disponibile.

## Correzioni

- `PRINT_SPOOL_SQL_PRIMARY=1` e' ora parte esplicita di
  `buildMultiprocessSharedEnv()` nel loadtest P4.
- L'auto-print e il mirror legacy non passano piu' da `dbMutation`.
- Nuova coda `latest-by-key-batch`: per ogni `jobId` conserva l'ultimo stato,
  rimette in coda senza perdere aggiornamenti in caso di errore e sincronizza
  batch da massimo 250 job.
- Il mirror compatibilita' usa esclusivamente questa coda dedicata e non entra
  piu' ne' in `dbMutation` ne' nella `printLane` autorevole.
- La sync MySQL legacy usa gli ID puntuali del batch, non l'intero dominio.
- `SIGINT` e `SIGTERM` drenano sia il flush ordini sia il mirror stampa.
- Aggiunti contatori e gauge runtime per enqueue, coalescing, batch, retry e
  profondita' pendente.
- Il drain P4 verifica anche owner/API worker, `printLane`, mirror pending e
  mirror running; non puo' piu' dichiarare verde con lavoro solo in memoria.
- Il mirror puo' essere inoltrato all'owner con soli ID e fallback locale. Nel
  canary finale e' disattivato con kill-switch, dato che SQL e' autoritativo.
- Il worker fisico gira realmente solo sull'owner e usa polling SQL; le API
  worker si limitano a creare i job durabili.
- Nel canary P4 gli eventi intermedi `claimed/sent`, l'evento iniziale
  ridondante `queued` e il probe TCP duplicato sono disattivati sotto flag.
- `PRINT_TCP_END_DELAY_MS=0` rimuove l'attesa fissa; il default resta 180ms per
  rollback conservativo fuori dal canary.

## Evidenza runtime

### Smoke prima del coalescing

- 10 palmari, 2 postazioni, 10 SSE, 130 operazioni business
- HTTP p95: 1.204ms
- `dbMutationEnqueued` sulle API worker: 228
- 119 stampe confermate, 0 pending, 0 failure finali
- tutte le mutazioni globali residue erano `print_spool_legacy_*`

### Full run 100 prima del coalescing

Run: `p4_local_paced_printlane_full_20260711_003010`

- 100 palmari, 10 postazioni, 100 SSE, 3.000 azioni in 299.779ms
- 2.000 ordini tentati, 1.807 confermati al client, 1.912 persistiti
- `order.create` p95: 3.722ms, contro 11.477ms della mediana P4 precedente
- HTTP globale p95: 7.047ms
- SSE p95: 1.062ms
- 0 pending stampa/outbox/fiscale al drain
- `dbMutationEnqueued=0` sulle due API worker
- mirror legacy rimasti in `printLane` a fine snapshot: 1.099 + 1.092
- RSS massimo API worker: 1.750MB e 1.703MB

Il run dimostra il miglioramento dell'isolamento, ma anche che i mirror non
coalescenti accumulavano memoria e lavoro non autoritativo.

### Smoke dopo il coalescing

Run: `p4_local_printmirror_metrics_20260711_004632`

- 10 palmari, 2 postazioni, 10 SSE, 130 operazioni business
- 0 failure, HTTP p95 852ms, SSE p95 347ms
- 50 ordini, 103 stampe confermate, 0 pending/failure finali
- `dbMutationEnqueued=0`
- mirror enqueue: 186
- mirror coalesced: 53
- stati effettivamente sincronizzati: 133 in 56 batch
- retry mirror: 0
- profondita' finale mirror e `printLane`: 0 / 0
- nessun deadlock MySQL nei log

Gli smoke usano workload casuale e non sono un confronto prestazionale A/B
deterministico. La rimozione delle etichette stampa da `dbMutation` e il drain
della coda sono invece verifiche strutturali deterministiche.

### Full run dopo coalescing, auth scoped e layout singleflight

Run: `p4_local_paced_lock_layout_postfix_20260711_005633`

- 100 palmari, 10 postazioni, 100 SSE, 3.000 azioni
- tutti i 2.000 ordini persistiti; 1.517 confermati entro il timeout client
- HTTP p95: 9.000ms; `order.create` p95: 7.627ms
- SSE p95: 466ms
- 1.462 stampe SQL ancora pendenti dopo 60 secondi di drain
- su una API worker osservata: `printLaneDepth=117`, mirror pending 127
- il batch `print_spool_legacy_batch` ha atteso fino a 119.407ms nella
  `printLane`

Il run ha confermato il guadagno di correttezza e realtime, ma ha isolato una
nuova contesa: il mirror compatibilita' coalescente tratteneva ancora la lane
autorevole della stampa.

### Smoke dopo separazione completa del mirror

Run: `p4_local_printmirror_dedicated_20260711`

- 10 palmari, 2 postazioni, 10 SSE, 120 operazioni business
- 0 failure; HTTP p95 628ms; SSE p95 291ms
- 99 stampe TCP virtuali confermate, 0 pending/failure finali
- drain relazionale completato, outbox unpublished 0
- entrambe le API worker: `dbMutation=0`, `printLaneDepth=0`, mirror pending 0
- mirror enqueue 180, coalesced 43, sincronizzati 137 in 64 batch, retry 0

La stampante e il fiscale erano simulatori loopback; nessun dispositivo reale
e nessun Raspberry sono stati contattati.

### Full run con mirror dedicato locale

Run: `p4_local_paced_printmirror_dedicated_full_20260711`

- 1.959/2.000 ordini persistiti; HTTP p95 9.000ms; SSE p95 462ms
- 1.123 stampe ancora pending dopo il drain
- 854 batch mirror sulle API worker, circa 0,55s medi ciascuno

La separazione dalla `printLane` era corretta, ma faceva competere direttamente
mirror MySQL e richieste business sulle API worker.

### Full run owner-only prima della riduzione TCP

Run: `p4_local_paced_print_owner_only_full_20260711`

- 1.909/2.000 ordini persistiti; 24/100 palmari al target completo
- 3.818 job creati, 2.055 confermati e 1.763 pending
- 104 flush mirror occupavano l'owner per 278,7s
- il ritardo TCP fisso limitava il singolo worker a circa 5,5 job/s

Questo run ha separato correttamente la proprieta' del worker, ma ha dimostrato
che mirror legacy e ritardo TCP rendevano ancora insufficiente la capacita'.

### Full run finale

Run: `p4_local_paced_print_zero_delay_full_20260711`

- 100 palmari, 10 postazioni, 100 SSE, 3.000 azioni cadenzate
- 2.000/2.000 ordini persistiti; 100/100 palmari al target di 20 ordini
- 4.000/4.000 stampe TCP virtuali confermate; pending/failure 0/0
- outbox unpublished 0; drain SQL e runtime completato in 19.452ms
- HTTP p50/p95/p99: 1.818 / 8.412 / 9.008ms
- `order.create` p95 7.529ms; `lock.acquire` p95 5.254ms, 2.000/2.000 OK
- SSE p50/p95/p99: 210 / 406 / 484ms
- owner/API worker/realtime CPU media: 46% / 67%+67% / 7%
- API worker RSS massimo: 732MB e 745MB
- `dbMutation=0`, mirror batch 0, tutte le code finali a zero

Rispetto al full run immediatamente precedente, il finale recupera tutti i 126
ordini mancanti, elimina 988 pending stampa, riporta SSE p95 da 760ms a 406ms e
riduce HTTP p95 da 9.002ms a 8.412ms.

## Test

- gate combinato architettura, unita', spool e crash recovery: 179/179 verde
- full run finale: 2.000 ordini e 4.000 stampe persistiti/confermati
- `backend/server.js`: 38.799 righe, margine M5 di 700 righe rispettato

## Stato P4

La pipeline stampa, la persistenza ordini, il drain e il realtime sono
**VERDI**. P4 resta **ROSSO per latenza HTTP**: il p95 e' 8.412ms e 255/400
letture layout superano il timeout client da 9s.

Il prossimo collo e' il routing delle lock: tutte le 2.000 `lock.acquire`
restano sull'owner insieme al worker stampa, pur avendo gia' stato relazionale
esternalizzato. Prossimo step: inoltrare acquire/heartbeat/release/force-release
alle API worker, verificare la coerenza cross-processo e ripetere un canary 100
prima delle due run di conferma finali.

Follow-up completato in `FASE_P4_TABLE_LOCK_WORKER_ROUTING_20260711.md`: il
pool API misto e' stato respinto dai canary; il profilo valido usa 2 API worker
e 1 `table-lock-worker` dedicato, con 2.000/2.000 ordini persistiti e lock p95
ridotto a 4.808ms.
