# Fase P3 - Diagnostica workflow bucket order lane

Data: 2026-07-03

## Obiettivo

Separare le latenze `orders/sync` per workflow richiesto (`ready`,
`delivered`, ecc.) prima di tentare altri interventi di coalescing/no-op.

Le probe precedenti su priorita statica e skip audit vuoto sono state respinte:
serviva quindi capire se il p95 alto fosse concentrato su un solo stato oppure
distribuito su tutta la order lane.

## Modifica applicata

`cassa-frontend/backend/modules/orders/order-lane-metrics.js` ora aggiunge al
label diagnostico:

- `wf=ready`
- `wf=delivered`
- `wf=prep`
- `wf=waiting`
- `wf=cancelled`
- `wf=none`
- `wf=other`

Il bucket viene letto da `payload.order.workflowStatus` o, in fallback, da
`payload.workflowStatus`.

Non cambia il comportamento runtime della comanda: cambia solo il label usato
da metriche e log della order lane.

## Verifiche statiche

- `node --check cassa-frontend/backend/modules/orders/order-lane-metrics.js`: OK
- `node --check cassa-frontend/backend/server.js`: OK
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/order-state-machine.test.mjs`: OK, 59/59

## Smoke

Run: `phaseP_interinale_p3_workflow_bucket_smoke_20`

- Palmari API: 20
- Postazioni API: 10
- Operazioni per device: 8
- Failure: 0
- `order.create` p95: 4014 ms
- `order.sync.ready` p95: 2226 ms
- `order.sync.delivered` p95: 2907 ms

Il report JSON contiene label distinti, ad esempio:

- `wf=ready`
- `wf=delivered`
- `wf=none` per create/correct/comp senza workflow richiesto

## Canary diagnostico

Run: `phaseP_interinale_p3_workflow_bucket_canary8_50`

- Palmari API: 50
- Postazioni API: 10
- Operazioni per device: 20
- Failure: 0
- Durata: 190 s
- `order.create` p95: 14126 ms
- `order.sync.ready` p95: 13961 ms
- `order.sync.delivered` p95: 14463 ms
- `order.correct` p95: 12791 ms
- `order.comp` p95: 12590 ms

## Aggregato order-lane wait

Da `runtimeMetrics.queues.orderLane.waitMsByLabel`:

| wf | Count | Avg ponderata | Max |
|---|---:|---:|---:|
| delivered | 110 | 9159 ms | 14375 ms |
| ready | 86 | 9355 ms | 13492 ms |
| none | 300 | 8972 ms | 14429 ms |

## Aggregato order-lane run

Da `runtimeMetrics.queues.orderLane.runMsByLabel`:

| wf | Count | Avg ponderata | Max |
|---|---:|---:|---:|
| delivered | 110 | 1194 ms | 2440 ms |
| ready | 86 | 1386 ms | 3136 ms |
| none | 300 | 1287 ms | 3169 ms |

## Conclusione

Il collo P3 non e' concentrato solo su `ready` o solo su `delivered`.

Le tre famiglie principali (`create`/`wf=none`, `sync ready`, `sync delivered`)
presentano wait medi simili, intorno a 9 secondi nel canary 50. Il problema e'
quindi pressione generale della order lane piu' che un singolo workflow lento.

La run non introduce regressioni funzionali: 0 failure e p95 allineati al
baseline P3 recente.

## Prossimo step consigliato

Procedere con una di queste due direzioni, evitando altre priorita statiche:

1. introdurre un no-op idempotente solo per sync duplicate gia' terminali
   (`current.workflowStatus === delivered` e richiesta `delivered/ready`),
   con test e2e che provi che non vengono creati audit/notifiche extra;
2. ridurre lavoro comune `create/sync` nella write ordine, perche' il p95 non
   dipende dal workflow ma dal volume complessivo che entra nella lane.

La prima opzione e' piu' circoscritta e misurabile: se non riduce il p95, va
rollbackata come le probe precedenti.

