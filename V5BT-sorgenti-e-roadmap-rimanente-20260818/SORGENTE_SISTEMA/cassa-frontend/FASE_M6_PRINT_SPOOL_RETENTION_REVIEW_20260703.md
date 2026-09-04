# Fase M6 - revisione print spool retention post-K

Data: 2026-07-03

## Obiettivo

Rivedere le soglie `.print-spool` alla luce del traffico post-K, dove piu'
pagamenti e piu' ricevute possono aumentare il numero di job e file stampa.

## Dati rilevati

Report endurance 50k disponibili: 10.

Picchi osservati:

- massimo `printSpoolJobs`: 320 (`endurance-50k-20260701082215`);
- massimo `print_spool_claim_next`: 508;
- p95 claim nel picco principale: `<=1000ms`.

Stato locale della directory `backend/.print-spool` al controllo:

- file `.txt`: 45;
- dimensione totale: 21.699 byte;
- dry-run retention senza record DB locali: 45 orfani;
- con soglia orfani 12h sarebbero selezionabili 45 file;
- nessuna pulizia reale eseguita durante M6.

## Decisione

Le soglie G2 erano funzionali, ma il limite `PRINT_SPOOL_MAX_JOBS=400` lasciava
solo circa il 20% di margine rispetto al picco post-K osservato di 320 job.

M6 alza quindi il buffer dei record spool e rende piu' rapida la pulizia degli
orfani non referenziati:

- `PRINT_SPOOL_MAX_JOBS`: da `400` a `1_200`;
- `PRINT_SPOOL_RETENTION_TERMINAL_HOURS`: resta `24`;
- `PRINT_SPOOL_RETENTION_ORPHAN_HOURS`: da `24` a `12`;
- `PRINT_SPOOL_RETENTION_INTERVAL_MS`: resta `3600000`;
- `PRINT_SPOOL_ORPHAN_ALERT_THRESHOLD`: resta `500`.

La distinzione e' intenzionale:

- i file terminali restano disponibili per debug/ristampa nella stessa giornata;
- gli orfani senza record DB non servono al workflow e possono essere rimossi
  prima;
- il buffer `1_200` lascia circa 3,75x il picco osservato post-K.

## Modifiche

- `backend/server.js`
  - default `PRINT_SPOOL_MAX_JOBS` portato a `1_200`;
  - default `PRINT_SPOOL_RETENTION_ORPHAN_HOURS` portato a `12`.

- `backend/tests/print-spool-retention.test.mjs`
  - aggiunto guardrail statico M6 sui default post-K;
  - aggiunto test piano retention M6: terminali dopo 24h, orfani dopo 12h,
    active job sempre protetti.

## Invarianti mantenuti

- I job non terminali (`queued`, `processing`, retry futuri) restano sempre
  protetti.
- I terminali referenziati non vengono cancellati prima di 24h.
- Gli orfani vengono cancellati solo oltre soglia.
- La retention resta disattivabile con `PRINT_SPOOL_RETENTION_ENABLED=0`.
- Nessuna stampante reale e nessun fiscale reale sono stati usati.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/print-spool/retention.js
```

Risultato: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/print-spool-retention.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Risultato: 10/10 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs
```

Risultato: 17/17 pass.

## Verifica operativa consigliata

Nel canary reale controllare:

- `runtimeMetrics.gauges.printSpoolOrphanFiles`;
- `runtimeMetrics.counters.printSpoolRetentionRuns`;
- `runtimeMetrics.counters.printSpoolRetentionDeletedFiles`;
- `runtimeMetrics.counters.printSpoolRetentionErrors`;
- `overview.operations.printSpool.total`;
- `overview.operations.printSpool.pending`.

Se i job reali superano stabilmente 900 o gli orfani superano 500, bisogna
riaprire M6 e valutare split/retention piu' aggressiva o storage dedicato.

## STOP/REVIEW

M6 e' chiusa. La Fase M e' completata; il prossimo passo della roadmap e' la
Fase N: state machine esplicite.
