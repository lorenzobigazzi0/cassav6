# Fase P3.69 - Cancel financial delta before snapshot

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo test: `PRINTING_ENABLED=0`, `FISCAL_REAL_IO_DISABLED=1`, `POS_FISCAL_REAL_IO_DISABLED=1`, `AUTOMATIC_CASH_REAL_ENABLED=0`

## Obiettivo

Ridurre la latenza di `orders.cancel` / cleanup nel canary multiprocesso evitando la lettura dello snapshot finanziario relazionale completo quando il cancel riguarda un solo tavolo non accorpato.

## Implementazione

- Aggiunto `BACKEND_ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT=1` al profilo P3 systemd.
- Aggiunto `buildOrderCancelFinancialDeltaBeforeSnapshotFastPath`.
- Il cancel ora fa:
  1. write-primary relazionale della comanda annullata;
  2. guard della revisione tavolo;
  3. delta finanziario locale se il guard e lo scope sono sicuri;
  4. fallback allo snapshot relazionale completo se serve.
- Risolto il caso reale `guard_mismatch` dei worker: il guard puo includere lo snapshot relazionale del tavolo e il delta lo usa come base sicura quando la cache worker e stale.
- Aggiunte metriche pinned:
  - `orderCancelInternal:*`
  - `orders.cancel.financialDeltaBeforeSnapshot.*`
  - counter hit/fallback del delta cancel.

## Test

Target Raspberry:

- `node --check backend/server.js`
- `node --check backend/modules/integration/order-financial-sync-source.js`
- `node --check backend/modules/integration/order-financial-table-write-guard.js`
- `node --test backend/tests/order-financial-sync-source.test.mjs backend/tests/order-financial-table-write-guard.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`

Esito: 135/135 pass.

Suite precedente completa dello step:

- `node --test backend/tests/order-financial-sync-source.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs`

Esito: 136/136 pass.

Budget `server.js`: 38.794 righe su 39.500, margine 706 righe.

## Canary Finale

Script:

`scripts/order-worker-sync-e2e-batch-canary.mjs`

Parametri:

- Iterazioni: 50
- Concorrenza: 1
- Tavolo: `room_attesa_virtuale_t03`
- Postazioni attive: `BAR PRINCIPALE`, `CUCINA`
- Routing: tutte le fasi su `api-worker`

Risultato:

| Metrica | P3.68 baseline | P3.69 finale |
| --- | ---: | ---: |
| create p95 | 501.26 ms | 611.48 ms |
| sync p95 | 228.66 ms | 168.03 ms |
| readback p95 | 37.56 ms | 70.19 ms |
| cleanup p95 | 871.12 ms | 231.08 ms |

Cleanup p95: -73,47% rispetto a P3.68.

## Metriche Runtime

Aggregato worker sul canary finale:

- `orderCancelFinancialDeltaBeforeSnapshotHits`: 50
- `orderCancelFinancialDeltaBeforeSnapshotFallbacks`: 0
- `orders.cancel.financialDeltaBeforeSnapshot.delta_applied`: 50

Split interno cancel:

- `financialGuardRead`: avg 0,38 ms, worker p95 max 1 ms
- `financialSnapshotRead`: avg 0,22 ms, worker p95 max 1 ms
- `financialTableWrite`: avg 1,44 ms, worker p95 max 5 ms
- `printSpool`: avg 31,06 ms, worker p95 max 100 ms
- `readDb`: avg 17,40 ms, worker p95 max 50 ms

## Artefatti

Cartella report locale:

- `reports/p3_69_cancel_delta_20260709/`

File principali:

- `final50_REPORT.md`
- `final50_result.json`
- `runtime_metrics_post_final50.json`
- `final50_metrics_summary.json`

Backup remoto pre-step:

- `/opt/cassav4/backups/p3-69-cancel-delta-before-snapshot-20260709-165351`

## Note

Il primo canary P3.69 aveva migliorato cleanup p95 a 643,63 ms ma mostrava 49 fallback su 50 per `guard_mismatch`. La correzione con snapshot tavolo nel guard ha portato il delta a 50/50 hit e ha rimosso quasi completamente il costo `financialSnapshotRead` dal percorso caldo di cancel.

Prossimo collo osservato: `printSpool` nel cleanup ha ancora p95 fino a 100 ms anche con stampa reale disattivata.
