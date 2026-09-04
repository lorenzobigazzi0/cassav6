# Fase P3 - Station reconciliation backpressure

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Il run precedente recuperava i deadlock ordine ma lasciava alcune
riconciliazioni postazione in `order-lane` con attese intorno a 280s. In questo
step la riconciliazione da polling postazione e' stata resa differibile sotto
pressione e con debounce iniziale, cosi' il burst live ordini entra prima e la
riconciliazione viene accodata solo quando la lane sta drenando.

## Correzioni applicate

- `station-orders-reconciliation` supporta:
  - `isBackpressureActive`
  - `backpressureDelayMs`
  - `deferInitialSchedule`
- Il server passa allo scheduler lo stato della `order-lane`:
  - `orderSyncLaneRunning`
  - profondita' dei task live con priorita superiore alla riconciliazione
- Aggiunte metriche `errorStage.<step>.<cause>` per capire in quale step dello
  split MySQL ordini avvengono gli errori transient.
- Il conflitto pagamento su comanda spostata da un altro flusso ora risponde
  `409 PAYMENT_ORDER_NOT_IN_TABLE`, non piu' `400`.

## Verifiche automatiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test \
  cassa-frontend/backend/tests/app-state-repository.test.mjs \
  cassa-frontend/backend/tests/runtime-metrics.test.mjs \
  cassa-frontend/backend/tests/route-policy-architecture.test.mjs \
  cassa-frontend/backend/tests/architecture-line-budget.test.mjs \
  cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs \
  cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs \
  cassa-frontend/backend/tests/notifications-persistence.e2e.test.mjs \
  cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs \
  cassa-frontend/backend/tests/station-orders-reconciliation.test.mjs
```

Risultato finale: 107/107 pass.

## Evidenza load

Run di confronto:

- retry-only:
  `logs/loadtest-phaseP_load-50-p3-rollbackcauses-postfix/report.json`
- backpressure senza debounce:
  `logs/loadtest-phaseP_load-50-p3-backpressure/report.json`
- debounce finale:
  `logs/loadtest-phaseP_load-50-p3-stationdebounce/report.json`

| Run | Durata | Anomalie | Retry ordine | Station reconciliation log |
|---|---:|---:|---:|---:|
| retry-only | 338s | 0 | 147 | 9 |
| backpressure | 342s | 0 | 163 | 7 |
| station debounce | 313s | 1 | 145 | 6 |

La singola anomalia del run `stationdebounce` era:

- `payment.free_split` 400 `Comanda non appartenente al tavolo selezionato.`

Dopo il run e' stata corretta a `409 PAYMENT_ORDER_NOT_IN_TABLE`, coerente con
un conflitto recuperabile da stale order/table durante spostamento tavolo e
pagamento concorrenti.

Attese riconciliazione postazione:

| Run | Max wait osservato |
|---|---:|
| retry-only | ~286.8s |
| backpressure senza debounce | ~283.9s |
| station debounce | ~2.2s |

Metriche `integration.orders.entries` nel run `stationdebounce`:

| Metrica | Count | Avg | Max |
|---|---:|---:|---:|
| `entries.total` | 579 | 229.71 ms | 1019 ms |
| `entries.error.transientDbError` | 145 | 0 ms | 0 ms |
| `entries.commit` | 434 | 21.03 ms | 313 ms |
| `entries.stateRead` | 579 | 10.76 ms | 215 ms |
| `entries.upsertChangedRows` | 579 | 9.88 ms | 212 ms |

## Diagnosi aggiornata

Il debounce risolve la coda lunga delle riconciliazioni postazione: non vengono
piu' accodate presto per poi aspettare minuti dietro il burst live.

La contesa transient residua e' ancora nel flusso ordine: `entries.error`
resta intorno a 145 eventi nel profilo ridotto. Il prossimo step deve usare
`errorStage` per capire se la contesa nasce da commit, indice postazione o
upsert riga ordine, poi ridurre quella specifica scrittura condivisa.

## Prossimo step

- Rilanciare un `load-50` breve leggendo le nuove metriche `errorStage`.
- Se il picco e' su `commit`, ridurre la durata/parallelismo transazionale.
- Se il picco e' su `orderStationIndex`, intervenire sugli upsert/delete
  dell'indice.
- Se il picco e' su `upsertChangedRows`, valutare batch/coalescing delle
  scritture puntuali ordine.
