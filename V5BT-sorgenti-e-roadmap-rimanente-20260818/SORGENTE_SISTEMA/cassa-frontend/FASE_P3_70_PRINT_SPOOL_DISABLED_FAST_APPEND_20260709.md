# Fase P3.70 - Print spool disabled fast append

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo test: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

Ridurre il costo residuo di `orders.cancel` emerso in P3.69: lo stage `printSpool` pesava ancora avg 31,06 ms e p95 100 ms anche con stampa reale disabilitata.

## Implementazione

- Aggiunto flag rollbackabile `PRINT_SPOOL_DISABLED_FAST_APPEND=1`.
- Quando `PRINT_SPOOL_SQL_PRIMARY=1` ma `PRINTING_ENABLED=0`, `appendPrintSpoolJobToDb`:
  - costruisce un job minimale `disabled`;
  - lo mantiene nel mirror `db.printSpoolJobs`;
  - salta l'inserimento nella coda SQL-primary `print_spool`;
  - non emette eventi operativi di stampa;
  - non risolve stampante/configurazione, perche la stampa e spenta.
- Secondo taglio: il mirror disabled non fa piu scan/sanitize completo della lista ad ogni append; appende direttamente il job gia sanitizzato e fa prune solo se supera `PRINT_SPOOL_MAX_JOBS`.
- Aggiunte metriche:
  - counter `printSpoolDisabledFastAppends`;
  - label pinned `printSpool:disabledFastAppend`.

## Test

Target Raspberry:

- `node --check backend/server.js`
- `node --test backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs backend/tests/print-spool-sql-primary-closure.test.mjs`

Esito prima del secondo taglio: 127/127 pass.

Target Raspberry dopo builder minimale e append diretto:

- `node --check backend/server.js`
- `node --test backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs backend/tests/print-spool-sql-primary-closure.test.mjs`

Esito: 121/121 pass.

Budget `server.js`: 38.799 righe su 39.500, margine 701 righe.

## Canary Finale

Script:

`scripts/order-worker-sync-e2e-batch-canary.mjs`

Parametri:

- Iterazioni: 50
- Concorrenza: 1
- Tavolo: `room_attesa_virtuale_t03`
- Postazioni attive: `BAR PRINCIPALE`, `CUCINA`
- Routing: tutte le fasi su `api-worker`

Risultato finale con append diretto:

| Metrica | P3.69 | P3.70 |
| --- | ---: | ---: |
| create p95 | 611.48 ms | 386.89 ms |
| sync p95 | 168.03 ms | 127.50 ms |
| readback p95 | 70.19 ms | 41.63 ms |
| cleanup p95 | 231.08 ms | 174.17 ms |

Cleanup p95: -24,63% rispetto a P3.69 e -80,01% rispetto al baseline P3.68.

## Metriche Runtime

Aggregato worker sul canary finale:

- `printSpoolDisabledFastAppends`: 150
- `orderCancelFinancialDeltaBeforeSnapshotHits`: 50
- `orderCancelFinancialDeltaBeforeSnapshotFallbacks`: 0

Split interno cancel:

- `printSpool`: avg 4,40 ms, worker p95 max 10 ms
- `disabledFastAppend`: avg 0,15 ms, worker p95 max 1 ms
- `financialSnapshotRead`: avg 0,36 ms, worker p95 max 5 ms
- `financialTableWrite`: avg 3,92 ms, worker p95 max 5 ms
- `readDb`: avg 18,46 ms, worker p95 max 50 ms
- `realtimePublish`: avg 5,10 ms, worker p95 max 10 ms
- `relationalPrimary`: avg 4,20 ms, worker p95 max 10 ms

Riduzione dello stage `printSpool` rispetto a P3.69:

- avg: 31,06 ms -> 4,40 ms, -85,83%
- p95: 100 ms -> 10 ms, -90,00%

## Artefatti

Cartella report locale:

- `reports/p3_70_print_spool_disabled_fast_20260709/`

File principali:

- `direct_final50_REPORT.md`
- `direct_final50_result.json`
- `runtime_metrics_post_direct_final50.json`
- `direct_final50_metrics_summary.json`

Backup remoto pre-step:

- `/opt/cassav4/backups/p3-70-print-spool-disabled-fast-append-20260709-171603`

## Note

Questo fast path vale solo quando la stampa e disabilitata. Con `PRINTING_ENABLED=1`, il percorso SQL-primary resta invariato e continua a usare la coda autoritativa `print_spool`.

Prossimo collo probabile: la variabilita residua del cleanup e ora dominata da `readDb` e da rari outlier di pubblicazione realtime / write relazionale, non piu dallo spool disabled.
