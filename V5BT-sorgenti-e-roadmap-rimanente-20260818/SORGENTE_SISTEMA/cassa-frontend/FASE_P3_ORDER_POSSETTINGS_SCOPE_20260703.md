# Fase P3 - Order posSettings scope

Data: 2026-07-03

## Obiettivo

Proseguire il gate interinale P3 sulla `orderLane` riducendo il costo medio
delle create/sync ordini. Il canary precedente indicava che la coda non era
dominata dagli ordini grandi: anche create da 1 riga e 2-3 righe restavano nel
p95 alto. Il prossimo sotto-costo aggredibile era
`orders.create.mysql.posSettingsTables`.

## Modifica

- `syncPosTableFinancialsFromIntegrationOrders` ora restituisce anche
  `tableIds`, cioe' gli id tavolo realmente modificati dal ricalcolo
  finanziario.
- `orders/create` non forza piu' `syncPosSettings: true`: sincronizza
  `posSettings.tables` solo se il ricalcolo finanziario ha prodotto una
  variazione.
- `orders/sync`, `comp`, `correct` e `cancel` usano gli id tavolo restituiti
  dal ricalcolo invece di ricostruire sempre il fallback `[tableId]`.
- Aggiunto guardrail in `route-policy-architecture.test.mjs` per mantenere il
  contratto `changed/tableIds` e impedire il ritorno al sync forzato sulle
  create.

## Verifiche

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-comp-write-primary.e2e.test.mjs cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs
```

Risultati:

- Architettura + runtime metrics: 48/48 pass.
- Suite funzionale ordini/pagamenti mirata: 27/27 pass.
- `server.js`: 38.794 righe, sotto budget M5.

## Smoke 20

Run: `phaseP_interinale_p3_possync_scope_smoke_20`

- Durata: 35 s
- Business ops: 150
- HTTP: 496
- Failure: 0
- RT fiscale reale: 0 tentativi
- Retry/deadlock/timeout nei log: 0
- `order.create` p95: 2910 ms
- `order.sync.delivered` p95: 2468 ms
- `orders.create.appStateWrite` avg: 258,55 ms
- `orders.create.mysql.posSettingsTables` avg: 35,85 ms, p95: 250 ms

## Canary 50 comparabile

Baseline: `phaseP_interinale_p3_crosslane_presence_confirm2_50`
Run nuovo: `phaseP_interinale_p3_possync_scope_canary12_50`

- Durata: 105 s
- Business ops: 720
- HTTP: 1828
- Failure: 0
- RT fiscale reale: 0 tentativi
- Retry/deadlock/timeout nei log: 0
- `crossDomainConcurrencyFamiliesActiveMax`: 5

| Metrica | Prima | Dopo |
|---|---:|---:|
| `orders.create.mysql.posSettingsTables` avg | 119,27 ms | 75,60 ms |
| `orders.create.mysql.posSettingsTables` p95 | 1000 ms | 250 ms |
| `orders.create.mysql.posSettingsTables` p99 | 2500 ms | 500 ms |
| `orders.create.appStateWrite` avg | 469,29 ms | 438,70 ms |
| `orders.create.appStateWrite` p99 | 2500 ms | 1000 ms |
| `order.create` p95 | 12245 ms | 11926 ms |
| `order.sync.ready` p95 | 11335 ms | 10832 ms |
| `order.sync.delivered` p95 | 11958 ms | 10843 ms |
| `order.correct` p95 | 13063 ms | 12304 ms |
| `orderLane` wait p95 max | 12502 ms | 11823 ms |
| `orderLane` run p95 max | 5000 ms | 2500 ms |

## Decisione

Promossa come ottimizzazione locale della create ordine: riduce chiaramente il
costo e la varianza di `posSettingsTables`, mantiene 0 failure e non introduce
deadlock o retry nel canary.

Non chiude P3:

- la `orderLane` resta satura con p95 end-to-end ancora intorno a 10-12 s;
- la coda lunga e' trasversale a bucket piccoli e grandi, quindi non basta
separare solo gli ordini pesanti;
- nel canary nuovo `waiter.pause.*` ha avuto p95 alto: da ricontrollare nel
prossimo giro, anche se il run non ha errori e il percorso modificato non tocca
direttamente la presence lane.

## Prossimo step

Calcolo capacita' P3 e attacco alla causa strutturale rimasta:

1. misurare throughput osservato della `orderLane` contro tempo medio di run;
2. decidere se alzare in canary la concorrenza oltre 8 o introdurre una lane
   distinta per create/sync leggere;
3. rieseguire canary 50 e confermare che `waiter.pause.*` torni stabile.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_possync_scope_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_possync_scope_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_possync_scope_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_possync_scope_canary12_50/REPORT.md`
