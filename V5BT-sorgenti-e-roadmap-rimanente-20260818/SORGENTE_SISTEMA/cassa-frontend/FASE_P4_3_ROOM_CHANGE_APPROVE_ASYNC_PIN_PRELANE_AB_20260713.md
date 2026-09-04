# Fase P4.3 - A/B PIN asincrono pre-lane room-change approve

Data: 2026-07-13

## Stato

Implementazione, test e canary A/B 20/50 completati. Il percorso e' disponibile
dietro:

```text
BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE=1
```

Il default codice e tutti i profili configurati restano `OFF`.

## Architettura

`verifyPinAsync` usa `node:crypto.scrypt` con lo stesso formato hash, parametri,
`maxmem` e confronto timing-safe del percorso sincrono.

Prima dell'enqueue, il servizio
`backend/modules/pos-rooms/room-change-approve-pin-proof.js`:

1. legge lo snapshot utente;
2. copia id, username normalizzato, hash PIN e ruolo;
3. verifica il PIN nel thread pool;
4. lega al solo oggetto HTTP una prova `Symbol`, non enumerabile e non
   serializzabile, senza includere il PIN;
5. registra metriche `posRoomChangeApprovePreLane`.

Dentro la route, dopo il nuovo `readDb`, la prova e' consumata una sola volta.
E' usabile solo se id, username, hash PIN, ruolo e stato privilegiato sono
ancora identici. Ogni differenza usa il `verifyPin` canonico sullo stato
corrente. Il controllo ruolo resta comunque nella route. Un `finally` elimina
la prova anche per richiesta scaduta o errore.

Il servizio non contiene mutazioni, delete relazionali, risposte HTTP o regole
di cambio sala. L'ordine delete relazionale -> mirror -> sessione/utente -> ACK
non cambia.

## Test

Sono coperti:

- PIN valido, errato e hash malformato;
- disponibilita' dell'event loop durante `verifyPinAsync`;
- flag spento senza letture aggiuntive;
- prova non serializzabile e single-use;
- cambio concorrente di id utente, hash PIN e ruolo;
- richiesta scaduta;
- riavvio reale del backend con richiesta pending persistita;
- percorso write-primary relazionale precedente;
- guardrail statico su posizione pre-lane e fallback canonico.

## Canary A/B

Baseline:

- 20 device: `p4_room_change_approve20_20260713_run1`;
- 50 device: `p4_room_change_approve50_20260713_run2`.

Flag attivo:

- 20 device: `p4_room_change_async_pin20_20260713_run1`;
- 50 device: `p4_room_change_async_pin50_20260713_run1`.

Tutti i run usano room lane concurrency 1, 12 approve validi e un PIN errato,
due API worker, un table-lock worker, MySQL, Redis, cinque GUI mobile, una GUI
postazione, stampa e mock I/O.

| Metrica | 20 OFF | 20 ON | 50 OFF | 50 ON |
| --- | ---: | ---: | ---: | ---: |
| business ops | 240/240 | 240/240 | 600/600 | 600/600 |
| approve validi | 12/12 | 12/12 | 12/12 | 12/12 |
| approve client p50 | 283 ms | 239 ms | 364 ms | 619 ms |
| approve client p95 | 1028 ms | 698 ms | 2334 ms | 1375 ms |
| lane wait approve medio | 95,17 ms | 9,08 ms | 290,42 ms | 267,42 ms |
| lane wait approve massimo | 806 ms | 60 ms | 1624 ms | 1061 ms |
| totale interno approve medio | 253,67 ms | 91,42 ms | 353,42 ms | 164,25 ms |
| PIN medio sync/async | 168,69 ms | 183,31 ms | 181,85 ms | 213,54 ms |
| app-state write medio | 80,42 ms | 86,17 ms | 165,33 ms | 156,75 ms |
| HTTP globale p95 | 659 ms | 667 ms | 1487 ms | 1270 ms |
| HTTP globale p99 | 1409 ms | 1682 ms | 4260 ms | 2580 ms |
| SSE p95 | 254 ms | 258 ms | 267 ms | 262 ms |
| MySQL redo | 54.747.136 B | 58.134.528 B | 107.932.672 B | 114.994.176 B |

I due run ON hanno zero failure, device tutti persistiti, drain completo e zero
problemi outbox, stampa e fiscal outbox. Tutte le 13 prove per run sono state
consumate; non sono comparsi fallback o riusi inattesi.

Il p95 approve migliora in entrambi i carichi. A 50 device migliorano anche
p95/p99 globali e SSE resta stabile. Il p50 approve a 50 e il p99 globale a 20
non migliorano: il PIN non sparisce, ma viene anticipato e puo' attendere nel
thread pool.

## CPU ed event loop

Il monitor multiprocesso del runner non raccoglie CPU/RSS su Windows. La misura
e' stata quindi integrata con:

```text
node scripts/benchmark-room-change-pin.mjs
```

Tre esecuzioni da 13 verifiche hanno prodotto:

| Metrica | sync | async |
| --- | ---: | ---: |
| wall time | 1735-2008 ms | 620-709 ms |
| CPU user+system | 1734-1907 ms | 2125-2375 ms |
| event-loop max | 1752-2009 ms | 20,8-23,9 ms |

L'asincronia elimina il blocco multi-secondo dell'event loop e usa i core in
parallelo, con circa 20-25% di lavoro CPU totale in piu'. Il lag SSE dei canary
resta stabile, ma un flood di approve potrebbe saturare il thread pool e deve
essere verificato prima del default ON.

## Decisione

**GO come candidato canary; NO-GO al default ON.**

Correttezza, sicurezza e tail latency approve migliorano. Il flag resta
esplicito e reversibile fino a:

1. load-100 con flag OFF/ON;
2. test burst delle verifiche PIN e saturazione thread pool;
3. raccolta CPU/RSS sul target Linux;
4. due run consecutivi senza regressione p99 globale o SSE.

## Prossimo intervento

Rivalutare, prima solo a livello di repository e transazione, un writer atomico
approve che elimini la richiesta pending e aggiorni sessione e ultima sala
utente nello stesso commit. Non comporre writer puntuali esistenti in
transazioni separate e non spostare l'ACK prima del commit durevole.

Se il writer atomico non e' dimostrabile senza una seconda fonte di verita',
chiudere questo endpoint con il solo PIN pre-lane e passare all'audit
`waiter pause/start/stop` previsto da P4.3.

## Verifiche

```text
npm run check:backend
node --check scripts/loadtest-full-capacity.mjs
node --check scripts/benchmark-room-change-pin.mjs
node --test --test-concurrency=1 backend/tests/room-change-approve-pin-proof.test.mjs backend/tests/room-change-approve-async-pin-prelane.e2e.test.mjs
node --test --test-concurrency=1 backend/tests/room-change-approve-telemetry.test.mjs backend/tests/relational-room-change-request-write-primary.test.mjs backend/tests/runtime-metrics.test.mjs
node --test --test-concurrency=1 --test-name-pattern="Fase P loadtest isola" backend/tests/phase-p-validation-preflight.test.mjs
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs
```
