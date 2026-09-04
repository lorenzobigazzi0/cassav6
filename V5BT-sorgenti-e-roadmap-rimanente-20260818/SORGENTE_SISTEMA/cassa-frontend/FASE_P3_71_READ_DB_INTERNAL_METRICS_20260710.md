# Fase P3.71 - ReadDb internal metrics

Data: 2026-07-10
Target: Raspberry `192.168.0.67`
Profilo test: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

Separare il costo interno di `readDb` emerso in P3.70 e distinguere la lettura
dell'app-state dai refresh esternalizzati di sessioni, lock tavoli, presenza
postazioni e sequenze di integrazione.

## Implementazione

- Aggiunto `recordReadDbInternalStep` nel boundary `readDb`.
- Esposte cinque label runtime pinned:
  - `readDbInternal:appStateRead`;
  - `readDbInternal:refreshSessions`;
  - `readDbInternal:refreshTableLocks`;
  - `readDbInternal:refreshStationStates`;
  - `readDbInternal:refreshSequence`.
- Le label restano disponibili anche quando il limite top-operations elimina
  metriche meno rilevanti.
- Aggiunte coperture in `runtime-metrics.test.mjs` e nel gate architetturale.

## Deploy e sicurezza

I checksum dei file locali e del deploy `/opt/cassav4/current/cassa-frontend`
sono identici. I servizi owner, due API worker, realtime e frontend sono stati
riavviati mantenendo disabilitati stampante TCP reale, fiscale reale e cassa
automatica reale.

Budget `backend/server.js`: 38.799 righe su 39.500, margine 701 righe.

## Test

Eseguiti sul Raspberry dopo deploy e canary:

- `node --check backend/server.js`;
- `node --check backend/modules/runtime-metrics.js`;
- `node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`.

Esito: 125/125 test pass, zero failure.

## Canary 50

Sono stati eseguiti due run consecutivi da 50 sequenze reali
`create -> sync -> readback -> cancel`, concorrenza 1, distribuiti sui due API
worker e con `BAR PRINCIPALE` e `CUCINA` attive nel relativo harness.

| Metrica p95 | Run 1 | Run 2 delta |
| --- | ---: | ---: |
| create | 304,30 ms | 265,13 ms |
| sync | 53,58 ms | 206,42 ms |
| readback | 36,69 ms | 34,37 ms |
| cleanup | 75,71 ms | 71,01 ms |

Entrambi i run hanno chiuso 50/50 operazioni senza errori. Tutti i p95 del
canary sono sotto 500 ms; il gate del singolo step e verde. Il gate P3 completo
resta distinto e richiede ancora il profilo burst/concorrenza previsto dalla
roadmap.

## Misura startup e delta operativo

Il primo snapshot ha mostrato una singola lettura app-state a freddo tra
19,65 s e 22,40 s per processo. Questo costo appartiene all'idratazione di
avvio e non alle richieste del canary. Per evitare medie false, la misura finale
usa snapshot per owner e worker immediatamente prima e dopo il secondo run.

Delta aggregato sui tre processi, 1.028 chiamate `readDb`:

| Stage interno | Somma | Media | Quota del costo misurato | p95 massimo worker |
| --- | ---: | ---: | ---: | ---: |
| refreshSessions | 2.030 ms | 1,97 ms | 65,44% | 10 ms |
| refreshTableLocks | 587 ms | 0,57 ms | 18,92% | 5 ms |
| appStateRead | 205 ms | 0,20 ms | 6,61% | 5 ms |
| refreshStationStates | 149 ms | 0,14 ms | 4,80% | 5 ms |
| refreshSequence | 131 ms | 0,13 ms | 4,22% | 1 ms |

Totale interno misurato: 3.102 ms, media 3,02 ms per `readDb`.

Nel percorso `orders.cancel`, lo stage esterno `readDb` misura 197 ms su 50
cancel, media 3,94 ms e p95 10 ms. Rispetto a P3.70, dove lo stesso stage
misurava 18,46 ms medi, nel run corrente non e piu un collo dominante.

## Stabilita runtime

- retry-like: 0;
- async flush retry: 0;
- async flush remote-owner fallback: 0;
- financial delta create: 50 hit, 0 fallback;
- financial delta cancel: 50 hit, 0 fallback;
- attesa order lane: 0,08-0,16 ms media a seconda dell'azione;
- servizi finali: tutti `active`.

## Conclusione e prossimo collo

P3.71 e chiusa. Il refresh sessioni e il componente maggiore dentro `readDb`,
ma il suo costo assoluto e circa 2 ms e non giustifica un nuovo fast path
immediato. La variabilita residua del run e invece visibile nelle scritture
relazionali e in singoli outlier di `orders/sync`; il prossimo step deve
strumentare o ridurre questi outlier senza cambiare il percorso `readDb`.

## Artefatti

Cartella:

- `reports/p3_71_read_db_internal_20260710/`

File principali:

- `order-worker-sync-e2e-batch-p3_71_read_db_internal_final50_20260710/`;
- `p3_71_read_db_internal_delta_final50/`;
- `pre_5281.json`, `pre_5283.json`, `pre_5284.json`;
- `post_5281.json`, `post_5283.json`, `post_5284.json`;
- `metrics_delta_summary.json`;
- `METRICS_DELTA_BREAKDOWN.md`.

Backup remoto pre-step gia presente:

- `/opt/cassav4/backups/p3-71-read-db-internal-metrics-20260709-173247`.
