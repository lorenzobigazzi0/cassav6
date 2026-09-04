# FASE P3.54 - Sync metric split

Data: 2026-07-09
Target: Raspberry 192.168.0.67
Deploy: /opt/cassav4/current/cassa-frontend
Profilo I/O: test safe, stampa/fiscale/cassa reale disattivati

## Obiettivo

La metrica `orderSyncInternal:relationalSnapshotRead` era troppo aggregata:
misurava anche bootstrap `readDb`, setup auth/workflow e query snapshot. Lo
scopo di P3.54 e' separare questi costi per guidare il prossimo taglio reale.

## Modifica

File modificati:

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`

Nuove label `orderSyncInternal`:

- `readDbBootstrap`
- `authWorkflowSetup`
- `relationalSnapshotRead`

Il comportamento applicativo non cambia: ACK, CAS, persistenza relazionale,
mirror async e real-time restano identici.

## Verifiche locali

- `wc -l backend/server.js`: 38.794 righe
- `node --check backend/server.js`: OK
- `backend/tests/route-policy-architecture.test.mjs`: 104/104 OK
- `backend/tests/runtime-metrics.test.mjs`: 5/5 OK

## Verifiche su Raspberry

Eseguite come utente servizio `cassav4`.

- `wc -l backend/server.js`: 38.794 righe
- `node --check backend/server.js`: OK
- `backend/tests/route-policy-architecture.test.mjs`: 104/104 OK
- `backend/tests/runtime-metrics.test.mjs`: 5/5 OK

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

Nota: durante il riavvio l'owner ha emesso un warning non bloccante di startup
reconcile su CAS MySQL (`app_state_domain_records_order_station_index`). I
servizi sono rimasti attivi e il canary successivo e' passato.

## Canary

Run: `p3_54_sync_metric_split_c1_50_20260709`

- PASS
- 50/50 OK
- durata: 138.272 s

| step | p95 |
| --- | ---: |
| create | 928.14 ms |
| sync | 763.63 ms |
| cleanup | 369.49 ms |
| readback | 418.44 ms |

## Risultato metriche interne

| blocco | worker 5283 avg | worker 5284 avg |
| --- | ---: | ---: |
| readDbBootstrap | 19.04 ms | 17.76 ms |
| authWorkflowSetup | 0.16 ms | 0.00 ms |
| relationalSnapshotRead | 136.60 ms | 138.88 ms |
| preparationPlan | 142.16 ms | 143.32 ms |
| financialSync | 174.76 ms | 194.76 ms |
| queueReconcile | 88.68 ms | 84.60 ms |

## Lettura del risultato

P3.54 conferma che il collo non e' il bootstrap iniziale:

- `readDbBootstrap` pesa circa 18-19 ms.
- `authWorkflowSetup` e' trascurabile.
- la vera `relationalSnapshotRead` pesa ancora circa 137-139 ms.

Quindi P3.53 aveva migliorato la forma delle query, ma il costo residuo sta
ancora dentro lettura/idrazione snapshot relazionale. In parallelo restano alti
`financialSync` e `preparationPlan`.

## Evidenze

Directory locale:

`reports/p3_54_sync_metric_split_20260709/`

File principali:

- `canary/REPORT.md`
- `canary/result.json`
- `p3-54-order-sync-internal-summary.tsv`
- `p3-54-all-runtime-metrics.json`
- `p3-54-services.txt`

## Stato e prossimo step

P3.54 e' chiusa come fase diagnostica. Il prossimo step consigliato e' P3.55:
ottimizzare `relationalSnapshotRead` reale, probabilmente riducendo
l'idratazione dello snapshot workflow o introducendo un read model piu leggero
per il path `/api/integration/orders/sync`.
