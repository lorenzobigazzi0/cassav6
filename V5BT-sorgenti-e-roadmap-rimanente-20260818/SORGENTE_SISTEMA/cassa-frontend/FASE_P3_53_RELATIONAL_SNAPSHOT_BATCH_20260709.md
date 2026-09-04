# FASE P3.53 - Relational snapshot batch

Data: 2026-07-09
Target: Raspberry 192.168.0.67
Deploy: /opt/cassav4/current/cassa-frontend
Profilo I/O: test safe, stampa/fiscale/cassa reale disattivati

## Obiettivo

Ridurre il costo del percorso `orderSyncInternal:relationalSnapshotRead`,
emergente dopo P3.52 come collo principale dello sync ordini.

## Modifica

File modificati:

- `backend/db/relational/orders.repo.js`
- `backend/modules/integration/relational-order-create.js`
- `backend/tests/relational-orders.test.mjs`
- `backend/tests/route-policy-architecture.test.mjs`

Interventi:

1. `OrdersRelationalRepository.listOrders` ora supporta filtri batch:
   `stationIds` e `tableIds`.
2. I filtri batch usano `IN (...)` con dedup valori, evitando loop di query
   singole sullo stesso snapshot.
3. `listScopedRelationalOrders` usa una sola `listOrders({ stationIds })` e
   una sola `listOrders({ tableIds })`, mantenendo `getOrderById` puntuale per
   il target ordine.
4. Aggiunti test funzionali sui filtri batch e guardrail statico P3.53.

## Verifiche locali

- `node --check backend/db/relational/orders.repo.js`: OK
- `node --check backend/modules/integration/relational-order-create.js`: OK
- `backend/tests/relational-orders.test.mjs`: 24/24 OK
- `backend/tests/route-policy-architecture.test.mjs`: 103/103 OK

## Verifiche su Raspberry

Eseguite come utente servizio `cassav4`.

- `node --check backend/db/relational/orders.repo.js`: OK
- `node --check backend/modules/integration/relational-order-create.js`: OK
- `backend/tests/relational-orders.test.mjs`: 24/24 OK
- `backend/tests/route-policy-architecture.test.mjs`: 103/103 OK

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`
- `cassav4-battery.service`

Flag safe confermati su owner e worker:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

## Canary

### Run A

Run: `p3_53_relational_snapshot_batch_c1_50_20260709`

- PASS
- 50/50 OK
- durata: 133.722 s

| step | p95 |
| --- | ---: |
| create | 792.78 ms |
| sync | 810.52 ms |
| cleanup | 352.06 ms |
| readback | 368.76 ms |

Metriche interne Run A:

| blocco | worker 5283 avg | worker 5284 avg |
| --- | ---: | ---: |
| relationalSnapshotRead | 159.00 ms | 146.28 ms |
| financialSync | 174.20 ms | 162.92 ms |
| preparationPlan | 142.36 ms | 140.00 ms |
| queueReconcile | 91.08 ms | 87.56 ms |

### Run B

Run: `p3_53b_relational_snapshot_batch_c1_50_20260709`

- PASS
- 50/50 OK
- durata: 130.623 s

| step | p95 |
| --- | ---: |
| create | 818.19 ms |
| sync | 723.66 ms |
| cleanup | 293.74 ms |
| readback | 290.10 ms |

Nota: prima del Run B e' stato azzerato l'owner via proxy, ma i runtime metrics
dei worker includono anche il Run A; per il confronto interno pulito usare le
metriche Run A.

## Confronto contro P3.52

P3.52:

- create p95: 862.50 ms
- sync p95: 736.46 ms
- cleanup p95: 375.55 ms
- readback p95: 412.45 ms
- relationalSnapshotRead avg: 152.48 / 157.72 ms

P3.53 Run B:

- create p95: 818.19 ms (-5.1%)
- sync p95: 723.66 ms (-1.7%)
- cleanup p95: 293.74 ms (-21.8%)
- readback p95: 290.10 ms (-29.7%)

Il batch `IN` migliora la forma delle query ed evita lavoro ridondante, ma non
riduce materialmente `relationalSnapshotRead`: il blocco resta attorno a
150-160 ms. Questo conferma che la label contiene ancora costo di bootstrap
iniziale/readDb oppure idratazione delle righe, non solo numero di query.

## Evidenze

Directory locale:

`reports/p3_53_relational_snapshot_batch_20260709/`

File principali:

- `canary/REPORT.md`
- `canary-b/REPORT.md`
- `p3-53-order-sync-internal-summary.tsv`
- `p3-53b-order-sync-internal-summary.tsv`
- `p3-53-all-runtime-metrics.json`
- `p3-53b-all-runtime-metrics.json`
- `p3-53-services.txt`

## Stato e prossimo step

P3.53 e' valido come hardening prestazionale del repository relazionale, ma non
chiude il collo `relationalSnapshotRead`.

Prossimo step consigliato: P3.54 separare la metrica iniziale in:

1. `readDbBootstrap`
2. `authWorkflowSetup`
3. `relationalSnapshotRead`

Poi ottimizzare il blocco piu grande. Dai dati attuali e' probabile che il
prossimo taglio reale sia fuori dalla query batch, tra bootstrap app-state,
idratazione snapshot e `preparationPlan`.
