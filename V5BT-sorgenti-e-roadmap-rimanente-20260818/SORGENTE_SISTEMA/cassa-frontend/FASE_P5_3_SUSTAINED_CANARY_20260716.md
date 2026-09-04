# Fase P5.3 - Canary sostenuto 20x5

Data: 2026-07-16.

Stato: correttezza e contesa MySQL verdi; gate endurance ancora rosso per
drift delle scritture full-state. Il run completo da 25.000 azioni non deve
essere avviato prima della correzione descritta in questo documento.

Aggiornamento: il blocco e' stato superato dalla P5.4. Il canary certificante
`p5_20x5_canary_2500_20260716152556` e' verde e il full e' ora il prossimo
gate. Vedere `FASE_P5_4_WRITER_ATOMICI_20260716.md`.

## Obiettivo

Eseguire un passaggio intermedio tra lo smoke P5.2 e il full endurance:

- 20 palmari e 5 postazioni;
- 100 azioni per device, 2.500 totali;
- massimo 3 avvii/s globali;
- 2 GUI mobile e 1 GUI postazione reali;
- 20 client SSE e radio;
- periferiche esclusivamente simulate su loopback;
- diagnostica di contesa separata per ciascun processo.

Il launcher espone ora tre modalita' non ambigue:

- `--smoke`: 8 azioni per device, 200 totali;
- `--canary`: 100 azioni per device, 2.500 totali;
- full senza flag: 1.000 azioni per device, 25.000 totali.

Smoke e canary possono usare quote ridotte; il contratto full resta rigido e
continua a rifiutare profili diversi da 20x5/25.000/3 al secondo.

## Primo canary e difetti trovati

Run: `p5_20x5_canary_2500_20260716101606`.

Il profilo ha completato 2.500/2.500 azioni, ma il gate e' rimasto rosso:

- 7 failure del generatore: 3 cambi sala e 4 prenotazioni tentati da `op20`
  su sale non presenti in `authorizedRoomIds`;
- 2 righe deadlock nei log del flush asincrono ordini;
- nessun retry MySQL registrato a livello richiesta;
- attesa massima coda mutation 430 ms e lane 278 ms.

`SHOW ENGINE INNODB STATUS` ha confermato un deadlock reale sulla tabella
`*_domains`: un writer bloccava `integration/sequence` e attendeva
`integration/lastWriteAt`, mentre l'altro possedeva `lastWriteAt` e attendeva
`sequence`.

La causa era nel merge MAX della sequence: il `SELECT ... FOR UPDATE` veniva
eseguito prima del loop gia' ordinato delle righe, invertendo l'ordine canonico
dei lock. Il lock della sequence viene ora acquisito dentro il loop ordinato,
esattamente quando la riga `integration/sequence` viene elaborata.

Il generatore seleziona inoltre soltanto tavoli e sale autorizzati per la
sessione. Gli scenari non applicabili vengono saltati senza allargare le
autorizzazioni backend.

## Regressione dopo la correzione

Test mirati:

```text
node --check backend/db/app-state/mysql-domains-split.repository.js
node --check scripts/loadtest-full-capacity.mjs
node --test backend/tests/mysql-domain-lock-order.test.mjs backend/tests/app-state-repository.test.mjs scripts/p5-endurance-contract.test.mjs
```

Esito: 58/58 test verdi.

Smoke: `p5_20x5_smoke_200_20260716103959`.

- 200/200 azioni, 0 failure;
- HTTP P50 23 ms, P95 269 ms, P99 356 ms, massimo 554 ms;
- 0 retry MySQL, 0 deadlock, 0 promozioni starvation;
- attesa massima coda mutation 79 ms, lane 1 ms;
- outbox e code relazionali drenate.

## Canary finale

Run: `p5_20x5_canary_2500_20260716104351`.

Correttezza e realtime:

- 2.500/2.500 azioni completate, 0 failure e 0 risposte GUI inattese;
- pacing valido: massimo 3 start/s, gap minimo 333,19 ms;
- 20/20 client realtime e 20/20 client radio connessi;
- realtime delivery P95 253 ms, P99 268 ms, massimo 1.290 ms;
- 100 comande persistite, 5 per ciascuno dei 20 palmari;
- event outbox non pubblicati: 0;
- spool stampa pending/failed final: 0/0;
- fiscal outbox problematici: 0;
- payment mirror pending/failed: 0/0;
- duplicati idempotency pagamento/fiscale: 0/0;
- quattro processi runtime raggiungibili e code tutte a zero al drain.

Contesa MySQL:

- 16.667 richieste diagnostiche valide, 0 righe JSONL invalide;
- 0 retry MySQL, 0 deadlock log, 0 deadlock InnoDB;
- 0 promozioni anti-starvation;
- attesa massima coda mutation 394 ms, lane 250 ms;
- 75 attese lock InnoDB, 3.555 ms complessivi;
- gate automatico contention verde.

Latenze globali:

- HTTP P50 17 ms, P95 234 ms, P98 383 ms, P99 469 ms, massimo 1.017 ms;
- azione P50 69 ms, P95 427 ms, P99 816 ms;
- gli outlier azione da 18-34 secondi appartengono alle GUI reali: blackout,
  logout/relogin e pressioni prolungate previste dal contratto.

## Drift prestazionale residuo

Il canary non autorizza ancora il full da 25.000 azioni. Tra primo e ultimo
decile:

- HTTP P50 -5,00%, P95 +48,82%, P99 +120,70%;
- azioni P50 -4,17%, P95 +81,88%, P99 +54,17%.

Il P50 stabile esclude una saturazione generale della coda. La diagnostica per
richiesta localizza il peggioramento nel tempo di `writeDb`, non nel wait della
lane. Esempi P95 primo -> ultimo decile:

| Route | writeDb P95 iniziale | writeDb P95 finale |
| --- | ---: | ---: |
| `POST /api/integration/orders/cancel` | 0 ms | 736 ms |
| `POST /api/integration/table-groups/save` | 257 ms | 693 ms |
| `POST /api/payments/free-split` | 0 ms | 282 ms |
| `POST /api/integration/orders/correct` | 358 ms | 772 ms |
| `POST /api/integration/notifications/publish` | 104 ms | 461 ms |
| `POST /api/auth/session/status` | 94 ms | 521 ms |
| `POST /api/integration/layout/table/sync` | 187 ms | 457 ms |

Durante il run sono state osservate 951 richieste con almeno una `writeDb`:
tutte le 951 hanno marcato `fullStateFallbackUsed=true`. Le route legacy con
`splitDomains` molto ampi arrivano a dichiarare 33 domini per una singola
operazione. La dimensione delle tabelle del run e' passata da 360.448 a
8.634.368 byte e MySQL ha scritto circa 633 MB di redo log.

Questo comportamento e' coerente con la crescita delle latenze: il sistema
resta corretto e non accumula coda, ma alcune mutation continuano a ricostruire
o confrontare stato crescente invece di persistere soltanto i record toccati.

## Lacuna monitor Windows

Il monitor di processo legge esclusivamente `/proc/<pid>`. Su Windows il
canary produce quindi `maxRssMb=0` e `maxCpuTickDeltaPerSec=0` per tutti i PID.
MySQL, code e latenze sono valide, ma CPU/RSS per processo non sono certificate
su questa macchina. Prima del full serve un sampler portabile oppure metriche
di processo esposte direttamente da ciascun worker.

## Decisione del gate

- Correttezza funzionale: **GO**.
- Deadlock/retry/starvation: **GO**.
- Drain e consistenza relazionale: **GO**.
- Endurance e drift delle scritture: **NO-GO**.
- P5 complessiva: **aperta**.

## Prossimo passo P5.4

1. Eliminare i full-state fallback dalle route a maggior volume, iniziando da
   session status, notification pull/publish, gruppi tavolo e counter collect.
2. Portare cancel/correct e free-split su writer puntuali anche nei rami di
   conflitto/no-op, senza perdere audit o idempotenza.
3. Aggiungere al report tipo e timestamp delle azioni, separando GUI disruptive
   dalle mutation ordinarie.
4. Rendere CPU/RSS multiprocesso misurabili anche su Windows.
5. Ripetere smoke e canary 2.500. Il full 25.000 parte soltanto con drift
   stabile e nessun full-state fallback non giustificato.

## Artefatti

- `logs/loadtest-p5_20x5_canary_2500_20260716104351/report.json`;
- `logs/loadtest-p5_20x5_canary_2500_20260716104351/REPORT.md`;
- `logs/loadtest-p5_20x5_canary_2500_20260716104351/P5_ENDURANCE_REPORT.pdf`;
- `logs/loadtest-p5_20x5_canary_2500_20260716104351/p5-contention-report.json`;
- `logs/loadtest-p5_20x5_canary_2500_20260716104351/P5_CONTENTION_REPORT.md`;
- `logs/loadtest-p5_20x5_canary_2500_20260716104351/p5-latency-checkpoints.jsonl`.
