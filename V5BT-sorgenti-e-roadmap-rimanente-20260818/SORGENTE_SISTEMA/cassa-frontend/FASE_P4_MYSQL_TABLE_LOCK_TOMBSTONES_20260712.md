# Fase P4 - Tombstone persistenti per i lock tavolo MySQL

Data: 2026-07-12

## Obiettivo

Eliminare la contesa InnoDB causata dal ciclo `DELETE` alla release e nuovo
`INSERT` al successivo acquire, senza modificare la semantica CAS dei lock e
con rollback immediato al comportamento precedente.

## Implementazione

Nuovo flag, spento di default:

```text
BACKEND_MYSQL_TABLE_LOCK_TOMBSTONES=1
```

Quando il flag e attivo:

- la tabella `app_table_work_locks` usa la colonna
  `is_active TINYINT(1) NOT NULL DEFAULT 1`;
- la release aggiorna la riga a `is_active=0` invece di cancellarla;
- acquire e heartbeat riattivano sempre la riga con `is_active=1`;
- letture, hydrate e layout espongono solo righe attive;
- all'avvio vengono create righe inattive per tutti i tavoli noti;
- i lock scaduti sono convertiti in tombstone;
- la metrica `tableLockMysqlTombstoneWrites` conta le release convertite.

La migrazione usa `SHOW COLUMNS` e `ALTER TABLE` solo se la colonna manca. Il
percorso gestisce anche due processi che tentino la migrazione insieme.

## Rollback

```text
BACKEND_MYSQL_TABLE_LOCK_TOMBSTONES=0
sudo systemctl restart cassav4-table-lock-worker.service
```

La colonna `is_active` puo restare nel database. Con flag spento la release
torna a `DELETE`; ogni upsert imposta comunque `is_active=1`, quindi un
tombstone esistente viene riattivato correttamente e non diventa un lock
invisibile.

## Test MySQL diretto

Il test usa due tabelle temporanee, 56 tavoli, tre cicli completi e pool 8.
Verifica inoltre hydrate dopo nuova istanza, nessun lock fantasma e gara CAS a
20 concorrenti con un solo vincitore.

Risultati ripetuti:

| Target | Retry DELETE/INSERT | Retry tombstone | Errori tombstone |
| --- | ---: | ---: | ---: |
| Desktop | 226-297 | 0 | 0 |
| Raspberry ARM | 47-151 | 0 | 0 |
| Raspberry ARM finale | 62 | 0 | 0 |

## A/B HTTP ARM

Ogni processo e stato verificato in `/proc/<pid>/environ`. I profili usavano:

- pool MySQL 8;
- Redis persistente pool 4;
- 50 richieste concorrenti e 56 tavoli;
- 1 round di warm-up e 5 round misurati;
- 280 acquire, 280 heartbeat e 280 release per run;
- tabelle MySQL separate per baseline e candidato;
- tutti gli I/O hardware reali disabilitati.

| Profilo | Acquire p95 | Heartbeat p95 | Release p95 | Retry | Errori |
| --- | ---: | ---: | ---: | ---: | ---: |
| DELETE run 1 | 193 ms | 101 ms | 105 ms | 26 | 0 |
| Tombstone run 1 | 142 ms | 215 ms | 91 ms | 0 | 0 |
| Tombstone run 2 | 141 ms | 91 ms | 101 ms | 0 | 0 |
| DELETE run 2 | 163 ms | 108 ms | 112 ms | 25 | 0 |
| Tombstone run 3 | 147 ms | 102 ms | 90 ms | 0 | 0 |

Il primo heartbeat tombstone e stato trattato come outlier e non nascosto: il
run e stato ripetuto in ordine inverso e poi ancora dopo un nuovo baseline. I
due candidati successivi sono stabili.

Media dei due baseline contro i due candidati stabili:

- acquire p95: 178 -> 144 ms, **-19,1%**;
- heartbeat p95: 104,5 -> 96,5 ms, **-7,7%**;
- release p95: 108,5 -> 95,5 ms, **-12,0%**;
- retry: 51 -> 0, **-100%**.

## Fasi MySQL

Confronto tra il secondo baseline e il secondo candidato stabile, metriche
cumulative warm-up incluso su 1.008 mutazioni:

| Fase | DELETE | Tombstone |
| --- | ---: | ---: |
| `connection.wait` medio | 30,68 ms | 26,60 ms |
| `connection.hold` medio | 13,92 ms | 11,57 ms |
| `transaction.total` medio | 12,44 ms | 9,97 ms |
| `mutation.total` medio | 46,94 ms | 38,24 ms |
| retry | 25 | 0 |

## CAS multiprocesso e restart

Due worker distinti, stessa tabella tombstone:

- 280/280 gare con esattamente un HTTP 200 e un HTTP 409;
- doppio 200: 0;
- doppio 409: 0;
- errori release: 0;
- p50 42 ms, p95 70 ms, p99 110 ms, massimo 114 ms.

Dopo lo stop di entrambi i processi la tabella conteneva 56 righe e zero
attive. Una nuova istanza ha completato 56 acquire, heartbeat e release; al
termine erano ancora presenti 56 righe e zero attive.

## Deploy operativo

Il flag e attivo su `cassav4-table-lock-worker.service`, insieme a:

```text
BACKEND_MYSQL_CONNECTION_LIMIT=8
REDIS_PERSISTENT_CLIENT=1
REDIS_PERSISTENT_POOL_SIZE=4
```

Canary post-deploy:

- 1.008 mutazioni;
- retry 0, errori 0, release tombstone 336;
- acquire p50/p95/p99: 75/151/173 ms;
- heartbeat p50/p95/p99: 59/100/118 ms;
- release p50/p95/p99: 57/88/99 ms;
- `mutation.total` medio 39,79 ms;
- `transaction.total` medio 10,45 ms;
- auth Redis medio 6,77 ms, query sessione MySQL 0;
- 56 righe operative, 0 lock attivi al termine.

## Verifica

- suite applicativa locale con ambiente isolato: 41/41;
- test MySQL locale reale separato: 1/1;
- suite applicativa ARM con ambiente isolato: 41/41;
- test MySQL ARM reale separato: 1/1;
- CAS HTTP multiprocesso: 280/280;
- `backend/server.js`: 38.798 righe, margine architetturale invariato;
- checksum locale/remoto identici per tutti i file modificati;
- stampa, fiscale e cassa automatica reali sempre disabilitati.

Un primo lancio aggregato dei test ARM e stato scartato perche aveva ereditato
l'env di produzione nei fixture isolati. Il rilancio corretto separa la suite
applicativa con ambiente pulito dal test che richiede le credenziali MySQL.

## Prossimo step

Il churn delle righe e i retry da gap lock sono chiusi. Il costo dominante
rimasto sotto concorrenza e l'attesa del pool (`connection.wait` medio 27,73
ms nel deploy operativo). Il prossimo passo e rieseguire il gate mixed/load-100
con questo profilo, misurando separatamente worker lock, proxy e order worker,
prima di intervenire ancora sul pool MySQL.
