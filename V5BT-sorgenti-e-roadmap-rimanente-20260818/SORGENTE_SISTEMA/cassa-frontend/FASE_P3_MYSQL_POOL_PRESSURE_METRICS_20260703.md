# Fase P3 - Metriche pressione pool MySQL

Data: 2026-07-03

## Obiettivo

Continuare il Passo 3 di `ROADMAP_INTERINALE_P3_LATENZA.md` dopo la probe
respinta sullo scan puntuale `integration.orders`.

La domanda da chiarire era se la coda lunga ordini sia ancora dominata dal
costo logico dell'upsert oppure da pressione MySQL condivisa:

- attesa acquisizione connessione;
- durata di possesso connessione;
- SELECT condivise fatte dal pool;
- varianza di `ensure/getPool/getConnection` nel domain split.

## Modifica

Aggiunta diagnostica pool nel repository condiviso
`backend/db/app-state/app-state-mysql.repository.js`.

Metriche prodotte quando il flag e' attivo:

- `appStateMysql:connection.acquire`
- `appStateMysql:connection.hold`
- `appStateMysql:query.select`
- `appStateMysql:query.insert/update/delete/create/other`
- gauge `mysqlPoolActiveConnections`
- gauge `mysqlPoolPendingAcquires`

La diagnostica wrappa il pool MySQL condiviso, quindi copre anche i repository
split che chiamano direttamente `pool.getConnection()`.

## Decisione default

Le metriche sono **canary esplicito**:

```bash
BACKEND_MYSQL_POOL_METRICS=1
```

Default operativo: spento.

Motivo: il canary con metriche sempre attive ha dato segnale utile ma non e'
abbastanza neutro lato latenza. Meglio lasciarlo come strumento di misura P3,
non come overhead permanente.

## Test

Comandi eseguiti:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/app-state-mysql.repository.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/app-state.repository.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-name-pattern "pressione pool" cassa-frontend/backend/tests/app-state-repository.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Esito:

- unit pool pressure: 1/1 pass;
- runtime metrics: 5/5 pass;
- route-policy architecture: 44/44 pass;
- orders flow e2e: 7/7 pass;
- architecture line budget: 1/1 pass;
- `server.js`: 38.794 righe.

Guardrail aggiunti:

- il repository MySQL registra `appStateMysql:*` solo con
  `poolMetricsEnabled`/`BACKEND_MYSQL_POOL_METRICS=1`;
- le label `appStateMysql:*` restano pinnate nello snapshot runtime;
- le gauge MySQL vengono esposte e resettate;
- test default-off: anche passando `runtimeMetrics`, senza flag non vengono
  prodotte metriche pool.

## Smoke con flag attivo

Run: `phaseP_interinale_p3_mysql_pool_metrics_flag_smoke_20`

Env rilevante:

```bash
BACKEND_MYSQL_POOL_METRICS=1
ORDER_SYNC_FAST_LANE_CONCURRENCY=8
ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY=8
POS_FISCAL_API_BASE_URL=http://127.0.0.1:9
LOADTEST_FISCAL_SAMPLE_LIMIT=0
```

Risultati:

- durata: 32,7 s;
- business ops: 180;
- HTTP: 553;
- failure: 0;
- RT fiscale reale: 0 tentativi;
- `orderLaneEnqueued`: 104;
- coda finale `dbMutation/orderLane`: 0 / 0.

Metriche pool:

| Metrica | Count | Avg | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|
| `appStateMysql:connection.acquire` | 1016 | 2,25 ms | <=25 ms | <=50 ms | 68 ms |
| `appStateMysql:connection.hold` | 1016 | 27,48 ms | <=100 ms | <=250 ms | 528 ms |
| `appStateMysql:query.select` | 476 | 32,81 ms | <=100 ms | <=250 ms | 239 ms |
| `integration.orders.entries.getConnection` | 97 | 4,09 ms | <=25 ms | <=50 ms | 33 ms |
| `integration.orders.entries.total` | 97 | 55,59 ms | <=250 ms | <=500 ms | 492 ms |

## Canary diagnostico

Run: `phaseP_interinale_p3_mysql_pool_metrics_canary12_50`

Nota: questo canary e' stato eseguito prima di rendere la diagnostica
default-off. I numeri restano utili per la diagnosi, ma la versione finale la
attiva solo via flag.

- durata: 97,2 s;
- business ops: 720;
- HTTP: 1811;
- failure: 0;
- RT fiscale reale: 0 tentativi;
- `orderLaneEnqueued`: 314;
- coda finale `dbMutation/orderLane`: 0 / 0.

Metriche pool:

| Metrica | Count | Avg | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|
| `appStateMysql:connection.acquire` | 3105 | 14,52 ms | <=100 ms | <=250 ms | 414 ms |
| `appStateMysql:connection.hold` | 3105 | 59,95 ms | <=250 ms | <=1000 ms | 1330 ms |
| `appStateMysql:query.select` | 1389 | 59,65 ms | <=250 ms | <=500 ms | 919 ms |
| `integration.orders.entries.getConnection` | 282 | 40,63 ms | <=250 ms | <=250 ms | 219 ms |
| `integration.orders.entries.getPool` | 282 | 33,47 ms | <=500 ms | <=500 ms | 453 ms |
| `integration.orders.entries.ensure` | 282 | 41,55 ms | <=500 ms | <=1000 ms | 609 ms |
| `integration.orders.entries.total` | 282 | 174,88 ms | <=1000 ms | <=1000 ms | 858 ms |

Confronto operativo col baseline promosso
`phaseP_interinale_p3_ready_status_noop_canary12_50_nogui`:

| Metrica | Baseline | Canary diagnostico |
|---|---:|---:|
| `order.create` p95 | 9150 ms | 11317 ms |
| `order.sync.ready` p95 | 8166 ms | 11553 ms |
| `order.sync.delivered` p95 | 8145 ms | 11107 ms |
| `station.heartbeat` p95 | 1352 ms | 3886 ms |
| `waiter.pause.stop` p95 | 9688 ms | 7044 ms |
| Failure | 0 | 0 |

## Lettura

La diagnostica conferma che sotto burst il pool non e' gratis:

- `connection.acquire` cresce da p95 <=25 ms nello smoke a <=100 ms nel canary;
- `connection.hold` arriva a p99 <=1000 ms;
- `query.select` arriva a max 919 ms;
- `integration.orders.entries.ensure/getPool/getConnection` hanno varianza
  comparabile al costo dell'upsert vero e proprio.

Pero' il p95 utente peggiora quando la diagnostica e' sempre attiva. Per questo
lo step non promuove metriche pool default-on.

## Decisione

Step completato come strumento diagnostico P3 default-off.

Non e' una correzione del gate latenza. Serve per il prossimo intervento, che
deve ridurre il numero di acquisizioni/SELECT sulla strada critica oppure
spostare parte del lavoro fuori dal percorso HTTP.

## Prossimo step

Usare queste metriche con `BACKEND_MYSQL_POOL_METRICS=1` durante una probe
mirata a:

1. ridurre le acquisizioni multiple di connessione per singola mutazione ordine;
2. evitare SELECT/ensure ripetuti quando il repository e' gia' inizializzato;
3. valutare una transazione unica per i sotto-step puntuali di
   `writeIntegrationOrderSyncDb`, senza tornare a full-domain write e senza
   riattivare il batch MySQL cieco gia' respinto.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_mysql_pool_metrics_flag_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_mysql_pool_metrics_flag_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_mysql_pool_metrics_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_mysql_pool_metrics_canary12_50/REPORT.md`
