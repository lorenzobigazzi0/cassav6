# Fase P3 interinale - Probe batch MySQL ordini

Data: 2026-07-03

## Obiettivo

Proseguire il Passo 3 di `ROADMAP_INTERINALE_P3_LATENZA.md` riducendo il costo
medio di `orders.sync.mysql.orders` e `orders.create.mysql.orders`, senza
aumentare ancora la concorrenza della `order lane`.

## Modifica

Nel repository `mysql-domains-split.repository.js` e' stato aggiunto un fast path
batch per `integration.orders`:

- `upsertDomainRowsBatch`;
- ramo specifico per `integration.orders`;
- mantenimento dell'indice ordine/postazione tramite `syncOrderStationIndex`;
- fix di un bug latente nel rollback del path `syncObjectArrayEntriesFromAppState`.

Il batch non e' attivo di default. Dopo il canary e' stato lasciato dietro flag:

```bash
BACKEND_MYSQL_ORDER_ENTRY_BATCH_UPSERT=1
```

Default operativo: spento.

## Verifica statica

Comandi:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito: 47/47 pass.

`server.js` resta dentro il gate M5:

- `wc -l`: 38.795

## Smoke batch

Run: `phaseP_interinale_p3_order_batch_smoke_20`

- durata: 39,1 s
- business ops: 240
- failure: 0
- retry/deadlock nei log: 0

Metriche rilevanti:

- `orders.create.mysql.orders`: avg 65 ms, p95 <=250 ms
- `orders.sync.mysql.orders`: avg 137 ms, p95 <=500 ms
- `integration.orders.entries.upsertBatch`: avg 8 ms, p95 <=50 ms

Nello smoke il batch sembrava promettente.

## Canary 50 batch

Run: `phaseP_interinale_p3_order_batch_canary_50`

- durata: 228,2 s
- business ops: 1260
- HTTP: 3198
- failure: 0
- fiscale virtuale: 4/4
- retry/deadlock app-state: nessuno nel campione cercato

Confronto col canary 8 post-cache precedente
`phaseP_interinale_p3_order_bucket_cache_canary_50`:

| Metrica | Prima | Batch |
|---|---:|---:|
| Durata | 198,4 s | 228,2 s |
| `order.create` p95 | 14.678 ms | 20.789 ms |
| `order.sync.ready` p95 | 14.890 ms | 20.202 ms |
| `order.sync.delivered` p95 | 14.817 ms | 19.782 ms |
| `orders.create.mysql.orders` avg | 123 ms | 140 ms |
| `orders.sync.mysql.orders` avg | 440 ms | 449 ms |
| `integration.orders.entries.total` avg | 254 ms | 273 ms |

Il batch non migliora il carico pieno P3; peggiora la latenza end-to-end e non
abbassa il costo medio del path ordine sotto concorrenza.

## Decisione

Non promuovere il batch. Il codice resta disponibile solo come canary esplicito,
ma il default rimane il path precedente.

La prossima ottimizzazione non deve essere un batch cieco sugli upsert: sotto
load il costo sembra concentrarsi nella transazione complessiva, lock/pool e
indice/posSettings, non nella singola query di upsert.

## Prossimo passo

Continuare su P3 con uno di questi due filoni:

1. ridurre/condizionare `syncPosSettingsTablesFastPath` sulle create/sync,
   perche' `orders.create.mysql.posSettingsTables` resta ricorrente;
2. isolare i retry `waiter.pause.*`, che non sono order-lane ma continuano a
   impedire il gate globale zero-retry.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_order_batch_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_batch_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_order_batch_canary_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_order_batch_canary_50/REPORT.md`
