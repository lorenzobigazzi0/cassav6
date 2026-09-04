# Fase P4 - routing lock tavolo multiprocesso

Data: 2026-07-11

## Obiettivo

Togliere `acquire`, `heartbeat`, `release` e `force-release` dall'owner senza
perdere atomicita', autorizzazioni o coerenza tra processi e misurare l'effetto
al profilo finale da 100 palmari.

## Implementazione

- le quattro route lock sono classificate come `order-workflow` scalabile;
- il routing e' ammesso solo con lock e sessioni MySQL condivisi;
- e' disponibile il ruolo ristretto `table-lock-worker`, che accetta health,
  metriche interne e soltanto le route lock allowlisted;
- il proxy supporta il pool `BACKEND_TABLE_LOCK_WORKER_ORIGIN`;
- il worker lock non esegue job owner, publisher outbox o raccolta ricorsiva
  delle metriche peer;
- il loadtest esegue un preflight reale e bloccante di 11 passi: routing,
  contesa cross-processo, heartbeat, owner errato, release, permesso negato e
  force-release amministrativo.

Fuse canary:

```text
BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS=1
BACKEND_TABLE_LOCK_WORKER_ORIGIN=http://127.0.0.1:5297
```

Rollback: disattivare `BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS` e rimuovere
l'origine dedicata. Con il fuse spento resta disponibile il routing precedente
su API worker; senza i prerequisiti condivisi il proxy torna automaticamente
all'owner.

## Sicurezza e correttezza

- repository lock MySQL: lock nominativo, transazione e `SELECT ... FOR UPDATE`;
- sessioni autenticate lette dal repository MySQL condiviso;
- un secondo processo riceve `409 TABLE_LOCKED` durante una contesa;
- il rilascio di un owner diverso riceve `403`;
- `force-release` senza permesso riceve `403 PERMISSION_DENIED`;
- il ruolo dedicato rifiuta ordini, letture generiche e pagamenti;
- dopo il TTL finale: 0 lock attivi; restano 3 righe storiche scadute.

## Risultati A/B a 100 palmari

Profilo identico per tutti i run: 100 palmari, 10 postazioni, 5 GUI, 100 SSE,
2.000 ordini, 1.000 altre azioni, intervallo 10 secondi, stampa e fiscale solo
su simulatori loopback.

| Profilo | HTTP p95 | Lock acquire p95 | Order create p95 | Ordini persistiti | Device al target | Stampe confermate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline: lock su owner, 2 API | 8.412ms | 5.254ms | 7.529ms | 2.000 | 100/100 | 4.000 |
| Lock nel pool misto, 2 API | 8.030ms | 7.820ms | 5.712ms | 1.966 | 74/100 | 3.932 |
| Lock nel pool misto, 4 API | 8.763ms | 9.001ms | 4.000ms | 1.878 | 26/100 | 3.756 |
| Lock dedicato, 2 API + 1 lock | 7.918ms | 4.808ms | 7.017ms | 2.000 | 100/100 | 4.000 |

Run finale: `p4_local_paced_table_lock_dedicated_full_20260711`.

Confronto finale contro baseline:

- HTTP p95: -5,9%;
- lock acquire p95: -8,5%, 2.000/2.000 acquisizioni riuscite;
- order create p95: -6,8%;
- conferme ordine entro timeout: 1.604 contro 1.548, +3,6%;
- release scadute lato client: 443 contro 506, -12,5%;
- SSE p95: 427ms contro 406ms, ancora sotto il gate da 500ms;
- owner CPU media: 16% contro 46%; API worker: 68% e 65%; worker lock: 33%;
- print pending/failure, outbox unpublished e fiscal problem finali: 0;
- drain completo in 41.912ms.

Il pool misto a 2 o 4 processi e' respinto: sposta la coda sui worker che
eseguono gli ordini e perde correttezza entro la finestra. Il pool dedicato e'
l'unico profilo che migliora le latenze mantenendo 2.000/2.000 ordini e tutte le
code drenate.

## Test

- topology/proxy/architecture: 151/151 verdi;
- audit workflow e preflight preset: 19/19 verdi;
- e2e lock, CAS e permessi: 13/13 verdi;
- smoke dedicato: routing corretto, drain completo, lock 17-147ms;
- full canary dedicato: preflight 11/11, 2.000 ordini, 4.000 stampe virtuali;
- `backend/server.js`: 38.799 righe, margine M5 di 700 righe invariato;
- log del full canary: nessun deadlock, errore processo o route blocked.

## Stato P4

Lo step lock multiprocesso e' **VERDE per correttezza e isolamento**, ma P4
resta **ROSSO per latenza**. Il target `order.create` e' 300ms, mentre il p95 e'
7.017ms; 242/400 letture layout e 95/300 letture stato postazioni superano il
timeout client.

Prossimo step consigliato: profilare il burst del `table-lock-worker` e il path
layout. Il lock dedicato usa solo il 33% medio ma misura 1,595s medi lato route:
il sospetto principale e' il bootstrap `readDb` per richiesta, con refresh
sessioni e sanitize dell'intero `posSettings`. Serve un fast-auth puntuale e
una cache immutabile `tableId -> room/table metadata`, poi un nuovo canary 100.

Follow-up completato in `FASE_P4_TABLE_LOCK_REQUEST_FASTPATH_20260711.md`:
fast-auth puntuale e indice tavoli sono attivi sotto flag sul Raspberry; nel
canary mirato il p95 acquire scende da 535ms a 398ms, heartbeat da 317ms a
180ms e release da 281ms a 174ms, con 504/504 operazioni riuscite.
