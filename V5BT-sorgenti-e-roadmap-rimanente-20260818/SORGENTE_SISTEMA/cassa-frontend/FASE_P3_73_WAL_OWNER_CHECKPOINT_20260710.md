# Fase P3.73 - WAL checkpoint owner-only

Data: 2026-07-10
Target: Raspberry `192.168.0.67`
Release: `/opt/cassav4/releases/20260707-test-safe-real-io-223951`

## Obiettivo

Rimuovere il checkpoint SQLite dal percorso di commit HTTP degli `api-worker`,
senza cambiare la durabilita delle scritture relazionali e mantenendo un
rollback operativo con una sola variabile.

P3.72 aveva isolato il collo:

- corpo transazione sotto 5 ms;
- `COMMIT` fino a 208 ms;
- `BEGIN IMMEDIATE` fino a 180 ms;
- WAL di circa 4,3 MB, vicino alla soglia autocheckpoint SQLite da 1000 pagine.

## Implementazione

Nuovo modulo:

```text
backend/db/relational/wal-checkpoint.js
```

Comportamento dietro flag:

```env
BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER=1
BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS=1000
```

Con il flag attivo:

- ogni connessione relazionale applica `PRAGMA wal_autocheckpoint = 0`;
- solo il ruolo `api-owner` esegue `PRAGMA wal_checkpoint(PASSIVE)`;
- `api-worker` e `realtime-gateway` non avviano timer;
- il timer parte dopo le migrazioni e viene fermato prima della chiusura DB;
- errori e stato busy vengono misurati ma non fanno cadere il processo;
- il timer e ricorsivo e `unref`, quindi non prolunga lo shutdown.

Con il flag disattivo:

- nessun timer owner;
- `PRAGMA wal_autocheckpoint = 1000`, comportamento precedente.

Il rollback e quindi:

```env
BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER=0
```

seguito dal riavvio dei processi backend.

Il drop-in dedicato e separato dal profilo ordini:

```text
deploy/systemd/60-p3-relational-wal-checkpoint.conf
```

e viene applicato a owner, api-worker e realtime, per evitare che una
connessione secondaria riattivi l'autocheckpoint.

## Telemetria

Nuove metriche runtime:

- run, busy, errori e pagine checkpointate;
- durata `relationalWalCheckpoint:passive`;
- pagine WAL log/checkpointed/backlog;
- checkpoint in corso e timestamp ultimo run;
- valore `wal_autocheckpoint` applicato alla connessione.

Le metriche sono pinned e incluse nel dashboard operativo.

## Test

Copertura aggiunta:

- flag OFF: autocheckpoint 1000 e scheduler spento;
- flag ON owner: autocheckpoint 0 e scheduler eletto;
- flag ON worker: autocheckpoint 0 ma nessun scheduler;
- DB SQLite reale in WAL con checkpoint PASSIVE;
- errore checkpoint non bloccante e misurato;
- metriche pinned/dashboard;
- profilo systemd Raspberry;
- gate architetturale P3.73.

Risultati:

- suite locali pertinenti verdi dopo la correzione di una sola failure
  intermedia di budget righe;
- `backend/server.js`: 38.799 righe logiche su 39.500, margine 700;
- target Raspberry: 132/132 test passati;
- nessun test usa stampante, fiscale o cassa automatica reali.

## Deploy safe

Backup prima del deploy:

```text
/opt/cassav4/backups/p3-73-wal-owner-checkpoint-20260710-102413
```

Flag verificati nei quattro processi backend:

```env
PRINTING_ENABLED=0
FISCAL_REAL_IO_DISABLED=1
POS_FISCAL_REAL_IO_DISABLED=1
AUTOMATIC_CASH_REAL_ENABLED=0
```

Stato finale:

- owner `5281`: active;
- realtime `5282`: active;
- worker `5283`: active;
- worker `5284`: active;
- frontend `5280`: active;
- battery `8765`: active;
- zero restart inattesi dopo il deploy.

L'avvio owner richiede circa 32 secondi per riconciliare 100 ordini e 56 stati
tavolo. Il primo health probe, eseguito prima della fine del bootstrap, era
prematuro; il servizio non era in crash.

## Canary 50

Due run validi consecutivi, ciascuno con 50 sequenze:

```text
create -> sync -> readback -> cancel
```

Configurazione:

- due api-worker;
- concorrenza harness 1, identica a P3.72;
- postazioni simulate `BAR PRINCIPALE` e `CUCINA`;
- tavolo `room_attesa_virtuale_t03`;
- utente `amalia`;
- I/O reale disabilitato.

| Metrica p95 | P3.72 run 1 | P3.73 run 1 | Delta | P3.72 run 2 | P3.73 run 2 | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| create | 317,22 ms | 221,34 ms | -30,23% | 343,19 ms | 217,24 ms | -36,70% |
| sync | 49,56 ms | 53,50 ms | +7,95% | 94,36 ms | 76,38 ms | -19,05% |
| readback | 34,22 ms | 34,39 ms | +0,50% | 31,09 ms | 43,76 ms | +40,75% |
| cleanup | 164,36 ms | 70,02 ms | -57,40% | 49,32 ms | 56,39 ms | +14,33% |

Media dei due p95:

- create: 330,21 -> 219,29 ms, `-33,59%`;
- sync: 71,96 -> 64,94 ms, `-9,76%`;
- cleanup: 106,84 -> 63,20 ms, `-40,84%`;
- readback: 32,66 -> 39,08 ms, ancora basso ma con varianza `+19,66%`.

Esito funzionale:

- 50/50 + 50/50;
- zero errori HTTP;
- tutte le create/sync/readback/cancel servite da `api-worker`;
- cleanup postazioni verificato in entrambi i run.

Un tentativo preliminare ha completato il carico ma non ha potuto scrivere il
report per ownership errata della cartella `/tmp`. E stato escluso; directory,
run ID e baseline metriche sono stati ricreati prima dei due run sopra.

## Breakdown transazioni

Le soglie p95/max sono ricavate sottraendo i bucket degli snapshot pre/post dei
due worker, quindi non includono il tentativo preliminare.

| Azione | Run | Totale medio | BEGIN medio | Body medio | COMMIT medio | Max bucket COMMIT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sync | 1 | 1,34 ms | 0,12 ms | 0,86 ms | 0,18 ms | <=1 ms |
| sync | 2 | 1,24 ms | 0,00 ms | 0,82 ms | 0,16 ms | <=5 ms |
| cancel | 1 | 1,52 ms | 0,04 ms | 0,98 ms | 0,36 ms | <=10 ms |
| cancel | 2 | 1,32 ms | 0,04 ms | 0,84 ms | 0,14 ms | <=1 ms |

Aggregato sui 100 eventi per azione:

- sync: commit medio 0,17 ms contro 3,10 ms P3.72, `-94,5%`;
- cancel: commit medio 0,25 ms contro 3,84 ms P3.72, `-93,5%`;
- sync: BEGIN medio 0,06 ms contro 1,88 ms P3.72, `-96,8%`;
- max bucket sync commit `<=5 ms` contro picco 208 ms;
- max bucket cancel commit `<=10 ms` contro picco 159 ms;
- max bucket sync BEGIN `<=1 ms` contro picco 180 ms;
- rollback transazionali: 0.

Il risultato conferma che checkpoint/fsync era la sorgente dei picchi di
commit e, indirettamente, dell'attesa writer.

## Checkpoint owner

| Metrica | Run 1 | Run 2 |
| --- | ---: | ---: |
| checkpoint | 70 | 75 |
| durata media | 66,69 ms | 49,01 ms |
| p95 bucket | <=250 ms | <=250 ms |
| max bucket | <=1000 ms | <=250 ms |
| pagine checkpointate | 12.329 | 14.629 |
| busy | 0 | 0 |
| errori | 0 | 0 |

Gauge finale owner:

```text
logPages=143
checkpointedPages=143
backlogPages=0
```

Worker e realtime espongono `walAuto=0`, zero run e zero backlog. Il file WAL
finale e circa 2,54 MB; l'allocazione fisica puo restare non nulla con
checkpoint PASSIVE anche quando il backlog logico e zero.

## Stabilita

- retry-like: 0;
- async flush retry: 0;
- async flush remote-owner fallback: 0;
- checkpoint busy/error: 0/0;
- financial delta create: 98 hit, 2 fallback gestiti;
- financial delta cancel: 100 hit, 0 fallback;
- gate P3 retry/stage: pulito;
- nessun `SQLITE_BUSY`, fatal o errore WAL nel journal post-deploy;
- tutti i servizi finali active.

## Esito e prossimo step

P3.73 e chiusa e il gate sequenziale da 50 e verde. Il checkpoint puo durare
decine o centinaia di millisecondi, ma ora tale costo resta sull'owner e non
allunga i commit degli api-worker.

Il prossimo step consigliato e P3.74: ripetere il ramp concorrente sul pool da
due worker, con tavoli distinti e snapshot WAL pre/post, per verificare il gate
`p95 <500 ms` sotto burst reale. Se `BEGIN IMMEDIATE` resta nei bucket bassi,
non serve introdurre un writer SQLite centralizzato. Se torna a crescere sotto
concorrenza, il passo strutturale successivo e serializzare le sole scritture
relazionali tramite un owner writer dedicato, non riportare il workflow HTTP
sull'owner.

## Artefatti

```text
reports/p3_73_wal_owner_checkpoint_20260710/
```

Contiene:

- report completi dei due canary;
- snapshot runtime pre/post di owner, realtime e due worker;
- `WAL_TX_DELTA_SUMMARY.json`;
- `metrics_delta_summary.json`;
- `METRICS_DELTA_BREAKDOWN.md`.
