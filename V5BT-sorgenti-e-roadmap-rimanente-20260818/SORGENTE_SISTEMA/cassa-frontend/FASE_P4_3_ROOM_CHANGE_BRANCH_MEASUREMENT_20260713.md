# Fase P4.3 - Misura rami room-change request

Data: 2026-07-13

## Stato

Telemetria, probe controllati, test e canary 20/50 completati. La misura non
autorizza una write puntuale per il ramo pending: il repository relazionale
impiega meno di 1 ms medio e non e' il collo di bottiglia. Non e' stato
introdotto alcun nuovo percorso di persistenza e non cambia il comportamento
dell'API.

## Confini architetturali verificati

`POST /api/pos/room-change/request` resta nella room lane e conserva i due
percorsi applicativi esistenti:

1. `direct`: aggiorna sia la sessione corrente sia l'ultima sala dell'utente;
2. `pending`: crea prima il fatto durevole `posRoomChangeRequests` nel
   repository relazionale e poi aggiorna il mirror app-state.

Una futura ottimizzazione direct dovra quindi scrivere insieme la sessione e
l'utente. Una futura ottimizzazione pending dovra conservare l'ordine
relational-primary -> mirror e gestire anche l'eventuale prune delle richieste
scadute. La misura non sposta queste regole nella telemetria.

## Telemetria e runner

Il modulo `backend/modules/pos-rooms/room-change-request-telemetry.js` registra
per ramo:

```text
posRoomChangeRequest:laneWait.<branch>
posRoomChangeRequest:dbQueueWait.<branch>
posRoomChangeRequest:readDbTotal.<branch>
posRoomChangeRequest:writeDbTotal.<branch>
posRoomChangeRequest:total.<branch>
```

Registra inoltre le fasi `authorization`, `direct.sessionMutation`,
`direct.appStateWrite`, `pending.prepare`, `pending.relationalWrite` e
`pending.appStateWrite`. Le label sono pinned nelle runtime metrics.

Il runner accetta `LOADTEST_ROOM_CHANGE_BRANCH_PROBES`; i probe creano una
sessione dedicata, eseguono coppie pending/direct e approvano la richiesta
pending tramite l'API reale. Il report separa anche le metriche client:

```text
room.change.request.direct
room.change.request.pending
room.change.request.other
```

Durante il primo canary e' emerso che il task della room lane non ripristinava
il contesto `AsyncLocalStorage` della richiesta. Il contesto viene ora
ripristinato attorno al mutator, come richiesto per attribuire correttamente
wait e I/O al singolo ramo. La correzione riguarda solo la propagazione della
telemetria; non modifica scheduling o regole di dominio.

## Canary validi

- 20 device: `p4_room_change_branch20_20260713_run2`;
- 50 device: `p4_room_change_branch50_20260713_run1`.

Entrambi usano 12 probe, room lane concurrency 1, due API worker, un table-lock
worker, frontend e GUI reali headless, MySQL, Redis, stampa e mock I/O.

| Metrica | 20 device | 50 device |
| --- | ---: | ---: |
| business ops riuscite | 240/240 | 600/600 |
| device con ordini persistiti | 20/20 | 50/50 |
| probe branch riusciti | 12/12 | 12/12 |
| direct count/fail | 19/0 | 31/0 |
| direct client p50/p95/p99 | 69/307/307 ms | 220/2933/2955 ms |
| pending count/fail | 12/0 | 12/0 |
| pending client p50/p95/p99 | 62/1292/1292 ms | 1040/2722/2722 ms |
| room lane wait medio/p95 bucket | 161,09/<=1000 ms | 629,84/<=5000 ms |
| room lane run medio/p95 bucket | 65,33/<=250 ms | 154,64/<=500 ms |
| direct lane wait medio | 26,74 ms | 514,32 ms |
| pending lane wait medio | 293,08 ms | 829,62 ms |
| direct total interno medio | 69,89 ms | 167,23 ms |
| pending total interno medio | 60,46 ms | 131,08 ms |
| direct write totale medio | 62,11 ms | 159,81 ms |
| pending write totale medio | 47,92 ms | 112,54 ms |
| pending repository relazionale medio | 0,69 ms | 0,85 ms |
| HTTP globale p95/p99 | 659/1328 ms | 1538/3866 ms |
| SSE p95 | 256 ms | 269 ms |
| MySQL redo log | 59.276.288 B | 94.592.512 B |

In entrambi i run il drain relazionale e' completo. Outbox non pubblicati,
stampe fallite, problemi fiscal outbox e failure del runner sono tutti a zero.
Nel run 50 risultano inoltre 100/100 ordini creati, 500/500 altre operazioni e
50/50 client realtime connessi.

Run escluso:

- `p4_room_change_branch20_20260713_run1`: funzionalmente verde, ma prodotto
  prima del ripristino del contesto `AsyncLocalStorage`; le metriche per ramo
  non attribuivano correttamente il lane wait e non sono utilizzabili per una
  decisione prestazionale.

## Decisione

**NO-GO per una write puntuale del ramo pending.**

Il repository relazionale pending pesa 0,69-0,85 ms medi. A 50 device il ramo
pending trascorre 829,62 ms medi in attesa della room lane e 131,08 ms medi nel
proprio handler. Anche il ramo direct mostra la stessa pressione: 514,32 ms di
wait medio contro 167,23 ms interni. La coda, non la singola INSERT, domina il
tempo osservato dal client.

Il ramo direct ha una write app-state piu costosa del pending, ma una write
puntuale sessione+utente aggiungerebbe complessita senza rimuovere il costo
dominante misurato. Non viene quindi introdotto un nuovo flag di produzione.

## Intervento successivo completato

L'A/B isolato della concorrenza keyed della room lane e' stato completato:

1. rendere il runner configurabile con un override dedicato, mantenendo `1`
   come baseline;
2. aggiungere test che stesso utente, stessa sala o stesse chiavi tavolo restino
   serializzati;
3. confrontare `ROOM_LANE_CONCURRENCY=1` e `2` con gli stessi 12 probe a 20 e
   50 device;
4. verificare equivalenza DB, zero conflitti, drain, p95/p99 client e SSE;
5. non modificare il default operativo finche due canary target non sono verdi.

I target concurrency 2 sono funzionalmente verdi ma falliscono il gate
prestazionale: a 20 device peggiorano p95/p99 globali; a 50 device pending p95
sale da 2722 a 9848 ms. Il fallback stabile viene allineato a 1. Risultati e
decisione sono in
`cassa-frontend/FASE_P4_3_ROOM_LANE_CONCURRENCY_AB_20260713.md`.

## Verifiche

```text
npm run check:backend
node --test --test-concurrency=1 backend/tests/room-change-request-telemetry.test.mjs
node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs
node --test --test-concurrency=1 backend/tests/relational-room-change-request-write-primary.test.mjs
node --test --test-concurrency=1 --test-name-pattern="last selected room" backend/tests/security.test.mjs
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs
```
