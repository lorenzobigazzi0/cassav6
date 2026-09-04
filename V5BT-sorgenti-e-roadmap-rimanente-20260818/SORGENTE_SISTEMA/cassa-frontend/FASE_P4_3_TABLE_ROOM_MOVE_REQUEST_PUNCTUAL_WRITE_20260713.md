# Fase P4.3 - Write puntuale di table-room-move request

Data: 2026-07-13

## Stato

Implementazione, test e canary A/B 20/50 completati. Il percorso e' corretto
ma non supera il gate prestazionale a 50 device. Il flag resta default OFF e
non deve essere promosso in produzione.

## Selezione endpoint

Nel canary 50 precedente, con il fast path `table.sync` attivo,
`POST /api/integration/layout/table/room-move/request` aveva p95 1759 ms contro
823 ms di `POST /api/pos/room-change/request`. E' stato quindi selezionato un
solo endpoint, senza modificare cambio sala, resolve, status o pending.

## Modifica

Il ramo pending continua a creare prima la richiesta nel repository
relazionale. Dietro il flag:

```text
BACKEND_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH=1
```

il mirror app-state scrive in modo sincrono:

1. la sola notifica aggiunta e i campi integration correlati in una transazione
   MySQL;
2. la sola richiesta `posTableRoomMoveRequests` identificata da `requestId`;
3. l'intero campo `waiterDeferredCalls` solo quando sono state davvero aggiunte
   chiamate differite.

Rollback immediato: flag assente oppure `0`.

## Invarianti e fallback

- Nessun ACK anticipato e nessuna coda asincrona nuova.
- La richiesta relazionale primaria resta il primo fatto durevole.
- Il fast path verifica tutti i writer e gli ID prima di iniziare.
- Se il prune ha rimosso richieste scadute, usa il writer completo per
  persistere anche le cancellazioni.
- Se un writer o un dominio non e' disponibile, il fallback avviene prima di
  ogni write.
- Un errore dopo l'avvio viene propagato; non esiste fallback silenzioso dopo
  una scrittura parziale.
- I rami direct, status, pending e resolve non sono stati inclusi.

## Telemetria

Contatori:

```text
tableRoomMoveRequestAppStateFastWrites
tableRoomMoveRequestAppStateFastFallbacks
tableRoomMoveRequestAppStateFastFallbackCollectionPruned
tableRoomMoveRequestAppStateFastFallbackInvalidScope
tableRoomMoveRequestAppStateFastFallbackRequestWriterUnavailable
tableRoomMoveRequestAppStateFastFallbackIntegrationWriterUnavailable
```

Breakdown:

```text
tableRoomMoveRequestWrite:mysql.integration
tableRoomMoveRequestWrite:mysql.request
tableRoomMoveRequestWrite:total
```

Il runner accetta
`LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH=1` e salva flag e
breakdown in `report.json` e `REPORT.md`.

## Canary A/B validi

- 20 OFF: `p4_table_room_move_canary20_baseline_20260713_run1`;
- 20 ON: `p4_table_room_move_canary20_target_20260713_run1`;
- 50 OFF: `p4_table_room_move_canary50_baseline_20260713_run1`;
- 50 ON: `p4_table_room_move_canary50_target_20260713_run2`.

| Metrica | 20 OFF | 20 ON | 50 OFF | 50 ON |
| --- | ---: | ---: | ---: | ---: |
| endpoint count/fail | 8/0 | 8/0 | 21/0 | 21/0 |
| endpoint p50 | 122 ms | 244 ms | 239 ms | 480 ms |
| endpoint p95 | 1144 ms | 1057 ms | 1555 ms | 2939 ms |
| endpoint p99 | 1144 ms | 1057 ms | 2013 ms | 3198 ms |
| room lane wait medio | 263,50 ms | 303,00 ms | 448,14 ms | 640,33 ms |
| room lane run medio | 17,75 ms | 12,63 ms | 50,43 ms | 44,57 ms |
| fast write count/fallback | 0/1 | 1/0 | 0/6 | 6/0 |
| fast write totale medio | n/d | 33,00 ms | n/d | 87,67 ms |
| HTTP globale p95 | 607 ms | 581 ms | 1121 ms | 1229 ms |
| HTTP globale p99 | 1233 ms | 1186 ms | 2257 ms | 3042 ms |
| SSE p95 | 251 ms | 252 ms | 264 ms | 268 ms |
| MySQL redo log | 54.181.888 B | 55.485.440 B | 100.046.848 B | 97.380.352 B |

Tutti i run validi completano operazioni business, ordini, persistenza e drain,
con outbox non pubblicati, stampe fallite e problemi fiscal outbox a zero. I
target eseguono 7/7 fast write e zero fallback.

Il costo medio di esecuzione della route diminuisce nei due target, ma il wait
della room lane aumenta. A 50 device peggiorano p50, p95, p99 e percentili HTTP
globali. La riduzione di redo non basta a compensare la regressione osservata.

Run escluso:

- `p4_table_room_move_canary50_target_20260713_run1`: 21/21 endpoint OK,
  6 fast write e zero fallback, ma la postazione non ha ripristinato la sessione
  dopo il blackout simulato. L'anomalia resta assegnata a P4.5.

## Verifiche locali

```text
npm run check:backend
node --test --test-concurrency=1 backend/tests/table-room-move-request-app-state-fastpath.test.mjs
node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs
node --test --test-concurrency=1 --test-name-pattern="aggiorna una voce array top-level|accorpa entries e object fields integration" backend/tests/app-state-repository.test.mjs
node --test --test-concurrency=1 backend/tests/relational-table-room-move-request-write-primary.test.mjs
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs
```

Le suite interessate sono verdi. Il preflight Phase-P mantiene i sette dry-run
Raspberry/Linux non eseguibili nel contesto Bash su Windows, gia' documentati.
`backend/server.js` resta a 38.800 righe, con 700 righe di margine sul budget
hard 39.500.

## Decisione

**GO per correttezza e reversibilita'; NO-GO per la promozione del flag.**

Il codice resta disponibile dietro flag per ulteriori misure, ma la
configurazione stabile deve mantenerlo OFF. Il prossimo intervento P4.3 deve
misurare separatamente i rami direct/pending di `room-change/request` e il loro
wait/run prima di proporre una nuova write puntuale.
