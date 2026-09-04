# Fase P4.3 - Misura room-change approve

Data: 2026-07-13

## Stato

Telemetria, test e canary 20/50 completati. La misura identifica due costi
principali: verifica PIN sincrona e mirror app-state. Il delete relazionale non
e' il collo di bottiglia. In questa fase non sono state modificate regole,
payload, ordine di persistenza o risposte API.

## Flusso e invarianti

`POST /api/pos/room-change/approve` resta nella room lane con concurrency
stabile 1 e conserva questo ordine:

1. lettura stato e prune richieste scadute;
2. lookup richiesta pending;
3. verifica credenziali, PIN e ruolo privilegiato;
4. delete write-primary nel repository relazionale;
5. rimozione dal mirror in memoria;
6. aggiornamento sessione e ultima sala dell'utente;
7. persistenza app-state;
8. risposta di approvazione.

Il fatto relazionale viene quindi eliminato prima del mirror. Errori di
revisione o DB continuano a interrompere il flusso senza ACK positivo.

## Telemetria

Il modulo condiviso
`backend/modules/pos-rooms/room-change-operation-telemetry.js` contiene solo la
misurazione. I wrapper request e approve definiscono metric kind e outcome,
senza importare regole di dominio.

Metric kind approve:

```text
posRoomChangeApprove
```

Fasi principali:

```text
readDb.handler
prepare.prune
requestLookup
authorization.lookup
authorization.pinVerify
authorization.role
pending.relationalDelete
state.requestRemoval
state.roomResolution
state.sessionMutation
state.appStateWrite
```

Outcome misurati: `approved`, `not_found`, `invalid_credentials`, `forbidden`
ed `error`. Per ciascun outcome sono registrati lane wait, db queue wait,
readDb totale, writeDb totale e durata interna. Le label sono pinned nelle
runtime metrics e il loadtest produce la sezione
`Runtime Metrics - room-change approve breakdown`.

## Canary validi

- 20 device: `p4_room_change_approve20_20260713_run1`;
- 50 device: `p4_room_change_approve50_20260713_run2`.

Entrambi usano concurrency room lane 1, 12 coppie direct/pending con approve
reale, due API worker, un table-lock worker, GUI headless, MySQL, Redis, stampa
e mock I/O.

| Metrica | 20 device | 50 device |
| --- | ---: | ---: |
| business ops riuscite | 240/240 | 600/600 |
| device persistiti | 20/20 | 50/50 |
| approve validi | 12/12 | 12/12 |
| approve client p50/p95/p99 | 283/1028/1028 ms | 364/2334/2334 ms |
| PIN verify medio/p95 bucket | 168,69/<=250 ms | 181,85/<=500 ms |
| app-state write medio/p95 bucket | 80,42/<=250 ms | 165,33/<=1000 ms |
| delete relazionale medio/p95 bucket | 0,83/<=5 ms | 1,33/<=25 ms |
| session mutation media | 0,08 ms | 0,08 ms |
| room resolution media | 2,25 ms | 4,83 ms |
| lane wait approved medio | 95,17 ms | 290,42 ms |
| totale interno approved medio | 253,67 ms | 353,42 ms |
| writeDb totale approved medio | 80,25 ms | 165,33 ms |
| HTTP globale p95/p99 | 659/1409 ms | 1487/4260 ms |
| SSE p95 | 254 ms | 267 ms |
| MySQL redo | 54.747.136 B | 107.932.672 B |

In entrambi i run validi failure, outbox non pubblicati, stampe fallite e
problemi fiscal outbox sono a zero; il drain relazionale e' completo. Il run 50
completa 100/100 ordini e 500/500 altre operazioni.

Ogni run include anche un PIN errato. L'outcome `invalid_credentials` resta
negativo, non elimina la richiesta e non esegue alcuna write.

Run escluso:

- `p4_room_change_approve50_20260713_run1`: telemetria approve completa, ma il
  runner registra la nota anomalia P4.5 della postazione che non ripristina la
  sessione dopo il blackout simulato. Non viene usato per il gate.

## Analisi

La verifica PIN e' il costo singolo piu stabile: 169-182 ms medi. Usa
`scryptSync`, quindi durante quel tempo blocca l'event loop del processo e
mantiene occupata la room lane.

Il mirror app-state e' il secondo costo: passa da 80 a 165 ms medi sotto
carico. Una write puntuale approve non e' ancora autorizzata: l'operazione deve
eliminare una entry `posRoomChangeRequests` e aggiornare sessione e utente. I
writer puntuali esistenti lavorano in transazioni separate e il writer array
non elimina entry assenti; introdurli direttamente perderebbe l'atomicita del
percorso completo.

Il delete relazionale pesa 0,83-1,33 ms e non deve essere ottimizzato. Lookup,
prune, ruolo, mutazione sessione e risoluzione sala non sono significativi.

## Decisione

**GO per la misura; NO-GO per rimuovere il PIN o introdurre subito una write
puntuale multi-repository.**

La sicurezza e l'ordine relational-primary restano invariati. Il primo costo da
affrontare e' la verifica sincrona dentro la lane, non il repository pending.

## Prossimo intervento

Completato in
`FASE_P4_3_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE_AB_20260713.md`: il candidato
e' funzionalmente verde nei canary 20/50 e resta dietro flag default OFF.

La specifica applicata e' stata:

Progettare e canarizzare, dietro flag default OFF, una prova PIN pre-lane:

1. aggiungere `verifyPinAsync` con `node:crypto.scrypt`, mantenendo formato hash
   e parametri correnti;
2. verificare il PIN prima dell'enqueue e conservare solo una prova effimera
   non serializzata, senza PIN o segreti in cache/log;
3. dentro la lane rileggere l'utente e confrontare id, hash PIN e ruolo con la
   prova;
4. se l'utente e' cambiato, non fidarsi della prova e usare il percorso sicuro;
5. mantenere messaggi generici e timing-safe compare;
6. testare race su cambio PIN/ruolo, PIN errato, richiesta scaduta e restart;
7. eseguire A/B 20/50 misurando event-loop, lane run/wait, CPU e p95/p99.

Solo dopo questo A/B va rivalutato un writer atomico dedicato che elimini la
richiesta e aggiorni sessione/utente in una singola transazione infrastrutturale.

## Verifiche

```text
npm run check:backend
node --check scripts/loadtest-full-capacity.mjs
node --test --test-concurrency=1 backend/tests/room-change-request-telemetry.test.mjs backend/tests/room-change-approve-telemetry.test.mjs backend/tests/runtime-metrics.test.mjs
node --test --test-concurrency=1 backend/tests/relational-room-change-request-write-primary.test.mjs
node --test --test-concurrency=1 --test-name-pattern="Fase P loadtest isola" backend/tests/phase-p-validation-preflight.test.mjs
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs
```
