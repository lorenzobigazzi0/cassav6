# Fase P3.74 - Ramp concorrente e coerenza layout

Data: 2026-07-10
Target: Raspberry `192.168.0.67`
Release: `/opt/cassav4/releases/20260707-test-safe-real-io-223951`

## Obiettivo

Verificare il gate P3 sotto concorrenza sul pool da due `api-worker`, con 50
tavoli distinti, telemetria relazionale/WAL e I/O reale disabilitato.

La sequenza applicativa usata e:

```text
lock -> create -> unlock -> sync prep -> readback -> lock -> cancel -> unlock
```

## Ramp iniziale

Il ramp iniziale e stato eseguito con `BAR PRINCIPALE` e `CUCINA` attive.
Il catalogo live contiene solo categorie instradabili al BAR, quindi il limite
operativo effettivo e di tre comande contemporaneamente in preparazione sulla
stessa lane.

| Run | Concorrenza | Esito | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C2 | 2 | 50/50 | 267,49 ms | 196,59 ms | 109,82 ms | 120,42 ms |
| C4 | 4 | 50/50 | 407,52 ms | 437,22 ms | 183,97 ms | 530,43 ms |
| C8a | 8 | 50/50 | 595,20 ms | 452,83 ms | 224,62 ms | 435,23 ms |
| C8b | 8 | 49/50 | 674,02 ms | 432,55 ms | 250,94 ms | 391,88 ms |

L'unico errore C8b e `PREPARATION_QUEUE_FULL` sull'ordine `04516`, tavolo
`room_gazebo_t05`: e backpressure business prevista, non deadlock o errore
infrastrutturale. L'ordine e stato annullato esplicitamente.

## Bug cross-worker trovato

Dopo i cleanup, `GET /api/integration/layout` continuava a mostrare su alcuni
tavoli una o due comande attive. Il database relazionale riportava invece
ordini e workflow correttamente annullati.

La causa era una divergenza di cache tra processi:

- create e cancel potevano essere servite da worker diversi;
- ogni worker manteneva una copia locale di `db.integration.orders`;
- il layout ricostruiva `ordersInProgress` e `orderHistory` dalla propria copia;
- un worker che aveva visto create ma non cancel conservava lo stato `waiting`
  o `prep` indefinitamente nell'interfaccia.

## Correzione

Nuovo flag, subordinato al read-primary ordini:

```env
BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY=1
```

Con il flag attivo il layout:

1. legge gli stati tavolo relazionali;
2. legge dal relazionale solo ordini attivi `waiting`, `prep`, `ready`,
   `delivered`;
3. costruisce financial sync e statistiche tavolo da quello snapshot;
4. non usa piu la cache ordini locale del worker per le comande attive.

La query snapshot globale ora applica realmente `workflowStatuses`; prima il
filtro veniva ignorato quando non erano presenti scope per ordine, tavolo o
postazione.

La metrica pinned e:

```text
orderWorkflow:integration.layout.relationalOrdersRead
```

Rollback:

```env
BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY=0
```

## Test e deploy

Copertura nuova:

- e2e con due backend, due app-state divergenti e DB relazionale condiviso;
- create sul processo A, cancel sul processo B;
- conferma che la cache A resti volutamente stantia;
- conferma che il layout A mostri zero ordini attivi grazie al relazionale;
- filtro globale per stati, metrica pinned e profilo deploy Raspberry.

Risultati:

- suite locale completa pertinente: `148/148`;
- suite selezionata sul Raspberry: `130/130`;
- `backend/server.js`: 38.799 righe su budget 39.500;
- backup pre-deploy:
  `/opt/cassav4/backups/p3-74-layout-relational-orders-20260710-110923`;
- owner, realtime, worker 5283/5284, frontend e battery finali `active`.

Flag di sicurezza verificati su owner e worker:

```env
PRINTING_ENABLED=0
FISCAL_REAL_IO_DISABLED=1
POS_FISCAL_REAL_IO_DISABLED=1
AUTOMATIC_CASH_REAL_ENABLED=0
```

Accettazione live diretta su 5281, 5283 e 5284:

- 50/50 tavoli trovati su ogni processo;
- zero `ordersInProgress`, `pendingBills`, importi dovuti o work lock;
- lettura ordini layout media 1,0-2,5 ms, massimo 3 ms;
- nessun fallback o errore nel journal.

## Ramp operativo post-fix

Poiche il catalogo instrada tutte le righe al BAR e la macchina a stati limita
la preparazione a tre comande per lane, la massima concorrenza operativa valida
e C3.

| Run | Esito | Durata | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C3a | 50/50 | 48,04 s | 657,03 ms | 389,71 ms | 155,44 ms | 331,23 ms |
| C3b | 50/50 | 45,37 s | 535,18 ms | 248,30 ms | 92,24 ms | 321,48 ms |

Tutte le operazioni sono state servite da `api-worker`. La distribuzione e
rimasta bilanciata:

- C3a create 20/30, sync 29/21, cancel 24/26 su 5283/5284;
- C3b create 27/23, sync 27/23, cancel 19/31 su 5283/5284.

Dopo entrambi i run i 50 tavoli erano puliti e il cleanup delle due postazioni
era verificato al primo tentativo.

Il gate `<500 ms` resta rosso per `create` su entrambi i run. Sync, readback e
cleanup restano sotto soglia.

## Breakdown

| Metrica | C3a | C3b |
| --- | ---: | ---: |
| order-lane create, media run | 298,22 ms | 276,58 ms |
| order-lane create, p95 bucket | <=1000 ms | <=500 ms |
| order-lane create, attesa media | 0,16 ms | 0,12 ms |
| order-lane create, attesa p95 | <=1 ms | <=1 ms |
| sync relazionale totale medio | 8,72 ms | 4,32 ms |
| sync `BEGIN IMMEDIATE` p95 | <=1 ms | <=1 ms |
| sync commit p95 | <=50 ms | <=25 ms |
| cancel relazionale totale medio | 6,46 ms | 3,46 ms |
| cancel `BEGIN IMMEDIATE` p95 | <=5 ms | <=1 ms |
| cancel commit p95 | <=25 ms | <=5 ms |

C3a contiene un solo outlier cancel `BEGIN` nel bucket `<=250 ms`; C3b non lo
ripete. Non c'e contesa writer persistente: la coda order-lane e praticamente
vuota e il tempo resta dentro l'esecuzione create.

Stabilita sui due run C3:

- rollback transazionali: 0;
- retry async flush: 0;
- fallback remote-owner: 0;
- checkpoint busy/errori: 0/0;
- checkpoint owner: 75 + 80 run;
- financial delta cancel: 100 hit, zero fallback;
- nessun `SQLITE_BUSY`, deadlock, fatal o restart.

Il writer SQLite non va centralizzato in questo step: i dati non mostrano una
contesa `BEGIN` sostenuta e aggiungere un hop owner non aggredirebbe il costo
dominante.

## Probe C8 waiting escluso

E stato provato un C8 tecnico con richiesta `waiting`. Il backend promuove
correttamente l'ordine a `prep` quando la lane ha capacita; quindi `waiting` non
puo essere usato per aggirare il limite operativo:

- 16 ordini promossi a `prep`;
- 34 risposte `PREPARATION_QUEUE_FULL`;
- 34/34 ordini rimasti prima del cleanup sono stati annullati esplicitamente;
- un preflight singolo senza heartbeat postazioni ha confermato la stessa
  promozione automatica.

Il probe e escluso dal gate prestazionale. Stato finale: 50/50 tavoli puliti e
zero postazioni canary attive.

## Esito e prossimo step

P3.74 e completata con due risultati distinti:

1. coerenza layout multiprocesso risolta e verificata;
2. gate concorrente create ancora rosso, senza evidenza di coda o contesa
   SQLite persistente.

Il prossimo step e P3.75 diagnostico:

- rendere pinned `orderCreateInternal:*`, `orderCreateAuditPrelude:*` e la
  durata della write-primary create;
- ripetere C3 con profilo CPU/per-stage;
- eliminare il costo sincrono dominante identificato dai dati;
- non introdurre un writer centralizzato salvo nuova evidenza di contesa.

## Artefatti

```text
reports/p3_74_concurrent_ramp_20260710/
```

Contiene report figli, snapshot metriche e CPU, layout pre/post, log cleanup,
journal, breakdown C3 e checksum sorgenti.
