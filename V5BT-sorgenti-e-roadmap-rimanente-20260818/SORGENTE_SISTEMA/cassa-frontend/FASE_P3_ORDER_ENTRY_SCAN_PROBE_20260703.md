# Fase P3 - Probe scan puntuale integration.orders

Data: 2026-07-03

## Obiettivo

Continuare il Passo 3 della roadmap interinale dopo
`FASE_P3_PENDING_TERMINAL_SYNC_PROBE_20260703.md`, concentrandosi sul costo
interno ancora dominante:

- `orderWorkflowStep:orders.sync.mysql.orders`;
- `appStateDomainSplit:integration.orders.entries.total`.

L'ipotesi provata era ridurre il lavoro CPU/memoria prima dell'upsert MySQL:
quando `syncObjectArrayEntriesFromAppState` riceve ID espliciti per
`integration.orders`, fermare lo scan dell'array appena tutti gli ID richiesti
sono stati trovati.

## Modifica provata

Modifica temporanea poi rimossa in
`backend/db/app-state/mysql-domains-split.repository.js`:

- sostituzione del `flatMap` completo di `normalizeObjectArrayEntryRows` con un
  ciclo a stop anticipato;
- comportamento invariato per sync senza ID espliciti, cioe' full field sync;
- test funzionale temporaneo con una voce successiva non leggibile, per
  dimostrare che il sync puntuale del primo ordine non ispeziona il resto
  dell'array;
- guardrail statico temporaneo in `route-policy-architecture.test.mjs`.

## Verifiche tecniche durante la probe

Prima del canary:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/app-state-repository.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-name-pattern "ferma lo scan ordini" cassa-frontend/backend/tests/app-state-repository.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-name-pattern "mysql order entry sync uses batch upsert fast path" cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito prima del canary:

- syntax check: OK;
- test puntuale scan: 1/1 pass;
- guardrail architetturale completo: 43/43 pass;
- e2e ordini: 7/7 pass;
- runtime/budget: 6/6 pass;
- `server.js`: 38.792 righe.

## Smoke MySQL

Run: `phaseP_interinale_p3_order_entry_scan_smoke_20`

- durata: 35 s;
- business ops: 180;
- failure: 0;
- RT fiscale reale: 0 tentativi;
- `orderLaneEnqueued`: 103;
- coda finale `dbMutation/orderLane`: 0 / 0.

Confronto con `phaseP_interinale_p3_ready_status_noop_smoke_20`:

| Metrica | Baseline smoke | Probe smoke |
|---|---:|---:|
| `integration.orders.entries.total` avg | 192,58 ms | 76,12 ms |
| `integration.orders.entries.total` p95 | <=1000 ms | <=500 ms |
| `orders.create.mysql.orders` avg | 148,47 ms | 65,80 ms |
| `orders.create.mysql.orders` p95 | <=500 ms | <=250 ms |

Lo smoke sembrava promettente sul costo interno.

## Canary 1

Run: `phaseP_interinale_p3_order_entry_scan_canary12_50`

- durata: 98 s;
- business ops: 720;
- HTTP: 1875;
- failure: 0;
- RT fiscale reale: 0 tentativi;
- `orderLaneEnqueued`: 308;
- coda finale `dbMutation/orderLane`: 0 / 0.

Confronto con baseline promossa
`phaseP_interinale_p3_ready_status_noop_canary12_50_nogui`:

| Metrica | Baseline | Probe |
|---|---:|---:|
| `orders.sync.mysql.orders` avg | 304,17 ms | 268,90 ms |
| `orders.create.mysql.orders` avg | 122,19 ms | 97,46 ms |
| `orders.create.mysql.orders` p95 | <=500 ms | <=250 ms |
| `integration.orders.entries.total` avg | 172,46 ms | 155,13 ms |
| `order.create` p95 | 9150 ms | 9674 ms |
| `order.sync.ready` p95 | 8166 ms | 10139 ms |
| `order.sync.delivered` p95 | 8145 ms | 10148 ms |
| `station.heartbeat` p95 | 1352 ms | 2129 ms |
| `waiter.pause.stop` p95 | 9688 ms | 12083 ms |

## Canary 2

Run: `phaseP_interinale_p3_order_entry_scan_canary12_50_b`

- durata: 104 s;
- business ops: 720;
- HTTP: 1794;
- failure: 0;
- RT fiscale reale: 0 tentativi;
- `orderLaneEnqueued`: 300;
- coda finale `dbMutation/orderLane`: 0 / 0.

Confronto con baseline promossa:

| Metrica | Baseline | Probe B |
|---|---:|---:|
| `orders.sync.mysql.orders` avg | 304,17 ms | 279,50 ms |
| `orders.create.mysql.orders` avg | 122,19 ms | 118,34 ms |
| `integration.orders.entries.total` avg | 172,46 ms | 173,16 ms |
| `order.create` p95 | 9150 ms | 17655 ms |
| `order.sync.ready` p95 | 8166 ms | 12072 ms |
| `order.sync.delivered` p95 | 8145 ms | 10486 ms |
| `station.heartbeat` p95 | 1352 ms | 14745 ms |
| `waiter.pause.stop` p95 | 9688 ms | 11195 ms |

## Decisione

Probe respinta e rollbackata.

Il taglio dello scan locale migliora alcuni micro-indicatori, soprattutto nello
smoke, ma non migliora il comportamento end-to-end. In due canary comparabili
peggiora `order.sync.ready`/`delivered` e aumenta la latenza laterale di
heartbeat e waiter pause. Il canary B conferma che il miglioramento locale non
e' stabile sotto carico.

## Stato finale codice

Ripristinato al comportamento promosso in
`FASE_P3_READY_STATUS_NOOP_20260703.md`:

- `normalizeObjectArrayEntryRows` e' tornata al `flatMap` precedente;
- rimossi il test temporaneo e il guardrail statico dello stop anticipato;
- il batch MySQL resta solo dietro flag esplicito, come da
  `FASE_P3_ORDER_MYSQL_BATCH_PROBE_20260703.md`.

Verifiche post-rollback:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/app-state-repository.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito post-rollback:

- syntax check: OK;
- guardrail architetturale: 43/43 pass;
- e2e ordini: 7/7 pass;
- runtime/budget: 6/6 pass;
- `server.js`: 38.792 righe.

## Prossimo step

Non riprovare lo stop anticipato dello scan array come intervento isolato.
Le prossime direzioni piu' promettenti sono:

1. isolare ulteriormente le richieste leggere da comp/correct/fallback che
   entrano nella stessa pressione di coda;
2. misurare `ensure/getPool/getConnection` nel path `integration.orders.entries`,
   perche' il canary mostra varianza alta indipendente dal solo scan JS;
3. lavorare sul lato coda/HTTP, non solo sul micro-costo MySQL, dato che i p95
   utente peggiorano anche quando il costo medio interno scende.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_order_entry_scan_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_entry_scan_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_entry_scan_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_entry_scan_canary12_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_entry_scan_canary12_50_b/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_entry_scan_canary12_50_b/REPORT.md`
