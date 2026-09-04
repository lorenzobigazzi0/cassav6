# Fase P3.72 - Relational transaction metrics

Data: 2026-07-10
Target: Raspberry `192.168.0.67`
Profilo test: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

Spiegare gli outlier P3.71 osservati nelle scritture relazionali di
`orders/sync` e `orders/cancel`, separando attesa writer SQLite, corpo CAS e
commit dal costo di mapping e idratazione dell'ordine.

## Implementazione

- `withRelationalTransaction` accetta un observer non invasivo e misura:
  - `beginImmediate`;
  - `body`;
  - `commit`;
  - `rollback`.
- `replaceOrderWithRevision` misura:
  - mapping righe;
  - update CAS;
  - cancellazione figli;
  - inserimento figli;
  - idratazione risultato;
  - totale.
- Le metriche sono pubblicate nella famiglia pinned
  `orderRelationalWriteInternal`, con scope distinti `sync` e `cancel`.
- La telemetria e protetta: un errore dell'observer non modifica l'esito della
  transazione.

## Correzione di robustezza

Il guard in-process delle transazioni veniva inserito prima di
`BEGIN IMMEDIATE`, ma la relativa rimozione era raggiunta solo se il BEGIN
riusciva. Un errore `SQLITE_BUSY` sul BEGIN poteva quindi lasciare la
connessione marcata come transazione attiva e far fallire tutte le richieste
successive con un falso errore di transazione annidata.

Il BEGIN e ora dentro il `try/finally`: il guard viene sempre rimosso, anche se
l'acquisizione writer fallisce. Un test dedicato simula il primo BEGIN fallito
e verifica che la transazione successiva completi normalmente.

## Test

Suite eseguita sia localmente sia sul Raspberry:

- check sintattico dei file modificati;
- `relational-persistence-mode.test.mjs`;
- `relational-orders.test.mjs`;
- `runtime-metrics.test.mjs`;
- `route-policy-architecture.test.mjs`;
- `architecture-line-budget.test.mjs`.

Esito su entrambi gli ambienti: 163/163 test pass, zero failure.

Budget `backend/server.js`: 38.799 righe su 39.500, margine 701 righe.

## Canary 50

Due run consecutivi, ciascuno con 50 sequenze
`create -> sync -> readback -> cancel`, due API worker e harness postazioni
`BAR PRINCIPALE`/`CUCINA`.

| Metrica p95 | Run 1 | Run 2 |
| --- | ---: | ---: |
| create | 317,22 ms | 343,19 ms |
| sync | 49,56 ms | 94,36 ms |
| readback | 34,22 ms | 31,09 ms |
| cleanup | 164,36 ms | 49,32 ms |

Esito: 50/50 + 50/50, zero errori HTTP.

## Breakdown transazioni

Valori aggregati sui due worker per ciascun run.

| Azione | Run | Totale medio | BEGIN medio | Body medio | COMMIT medio |
| --- | ---: | ---: | ---: | ---: | ---: |
| sync | 1 | 5,56 ms | 0,04 ms | 1,02 ms | 4,24 ms |
| sync | 2 | 6,68 ms | 3,72 ms | 0,84 ms | 1,96 ms |
| cancel | 1 | 8,66 ms | 0,02 ms | 0,90 ms | 7,46 ms |
| cancel | 2 | 1,26 ms | 0,06 ms | 0,74 ms | 0,22 ms |

Sulle 100 operazioni complessive per azione:

- `sync`: totale medio 6,12 ms; commit 3,10 ms; BEGIN 1,88 ms; body 0,93 ms;
- `cancel`: totale medio 4,96 ms; commit 3,84 ms; BEGIN 0,04 ms; body 0,82 ms.

Picchi osservati:

- commit sync: 208 ms;
- commit cancel: 159 ms;
- attesa `BEGIN IMMEDIATE` sync: 180 ms;
- corpo transazione: massimo 5 ms.

## Diagnosi

Il mapping dell'ordine, il CAS e la sostituzione delle righe figlie non sono il
collo: il corpo resta stabilmente sotto 5 ms. La coda lunga proviene da due
fenomeni SQLite condivisi tra processi:

1. commit WAL con jitter di checkpoint/fsync;
2. attesa occasionale del writer lock su `BEGIN IMMEDIATE`.

Questo spiega perche gli outlier cambiano worker e fase tra un run e l'altro,
mentre il costo medio applicativo resta basso.

## Stabilita

- retry-like: 0;
- rollback osservati: 0;
- async flush retry: 0;
- async flush remote-owner fallback: 0;
- financial delta cancel: 100 hit, 0 fallback;
- financial delta create: 99 hit, 1 fallback gestito;
- tutti i servizi finali: `active`.

## Prossimo step

P3.72 e chiusa. P3.73 deve spostare il checkpoint WAL fuori dal percorso HTTP,
dietro flag rollbackabile, e misurare nuovamente commit e BEGIN. La direzione
consigliata e disabilitare l'auto-checkpoint sulle connessioni applicative e
affidare checkpoint `PASSIVE` periodici all'owner, con backlog WAL e durata
esposti nelle runtime metrics. Se la contesa BEGIN resta significativa dopo il
taglio commit, il writer SQLite dovra essere serializzato su un solo processo.

## Artefatti

Cartella:

- `reports/p3_72_relational_tx_metrics_20260710/`

Contenuti principali:

- report completi dei due canary;
- snapshot runtime pre/post per owner e worker;
- `metrics_delta_summary.json`;
- `METRICS_DELTA_BREAKDOWN.md`.

Backup remoto pre-step:

- `/opt/cassav4/backups/p3-72-relational-tx-metrics-20260710-095018`.
