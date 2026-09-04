# Fase P3 - Ready status-only duplicate no-op

Data: 2026-07-03

## Obiettivo

Proseguire dopo `FASE_P3_ORDER_LIGHT_PRIORITY_20260703.md`: ridurre il numero
di task che entrano nella `orderLane` intercettando prima i sync gia'
idempotenti, senza saltare mutazioni reali su righe, quantita', note o routing.

## Modifica

Esteso `terminal-duplicate-sync-prelane.js` con un helper condiviso:

- gli ordini gia' `delivered` restano no-op per richieste `ready`/`delivered`,
  come prima;
- gli ordini gia' `ready` diventano no-op solo se la richiesta e' ancora
  `ready` e il payload ordine e' strettamente status-only;
- il payload status-only ammette solo `id`, `orderId`, `workflowStatus`,
  `station`, `ownerStation`;
- qualunque `items`, `lineRoutes`, note, lock o altro campo mutabile passa nel
  flusso normale della `orderLane`.

Lo stesso helper viene usato sia dal pre-lane sia dal fallback dentro
`orders/sync`, cosi' il comportamento resta coerente quando il pre-lane non
intercetta.

## Test

Comandi eseguiti:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/orders/terminal-duplicate-sync-prelane.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/order-terminal-duplicate-sync-prelane.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/orders-flow.e2e.test.mjs
```

Risultati:

- Sintassi server/module: OK.
- Guardrail mirati: 51/51 pass.
- E2E ordini: 7/7 pass.

## Load smoke

Run: `phaseP_interinale_p3_ready_status_noop_smoke_20`

- Config: 12 palmari API, 5 postazioni API, 3 GUI, 20 op/device.
- Durata: 60 s.
- Business ops: 400.
- Failure: 0.
- RT fiscale reale: 0 tentativi.
- Sync terminali duplicate no-op: 12 / 72, pre-lane 10.
- `orderLaneEnqueued`: 165.
- `order.create` p95: 3284 ms.
- `order.sync.ready` p95: 2772 ms.
- `order.sync.delivered` p95: 3497 ms.

## Canary medio comparabile

Run: `phaseP_interinale_p3_ready_status_noop_canary12_50_nogui`

Configurazione comparabile al burst16 storico:

- 50 palmari API.
- 10 postazioni API.
- 0 GUI Playwright.
- 12 op/device.
- Stampa fisica disabilitata.
- Campioni fiscali 0.

Risultati:

- Durata: 92 s.
- Business ops: 720.
- HTTP: 1793.
- Failure: 0.
- RT fiscale reale: 0 tentativi.
- Retry/deadlock/timeout nei log: 0.
- Sync terminali duplicate no-op: 25 / 121, pre-lane 16.
- `orderLaneEnqueued`: 309.
- `orderLane` wait avg: 5169 ms.
- `orderLane` run avg: 781 ms.

Confronto con `phaseP_interinale_p3_order_burst16_canary12_50`:

| Metrica | Burst16 | Ready status-only no-op |
|---|---:|---:|
| Durata | 99 s | 92 s |
| `order.create` p95 | 10453 ms | 9150 ms |
| `order.sync.ready` p95 | 10512 ms | 8166 ms |
| `order.sync.delivered` p95 | 10376 ms | 8145 ms |
| `order.correct` p95 | 10087 ms | 9235 ms |
| `orderLane` wait avg | 5900 ms | 5169 ms |
| `orderLane` run avg | 1044 ms | 781 ms |
| `station.heartbeat` p95 | 1171 ms | 1352 ms |
| `waiter.pause.stop` p95 | 6435 ms | 9688 ms |
| Failure | 0 | 0 |

## Nota sul canary con GUI

Eseguito anche `phaseP_interinale_p3_ready_status_noop_canary12_50` con 5 GUI
Playwright reali. Non e' confrontabile col burst16 storico perche' aumenta il
carico a 780 business ops e peggiora il p95 di heartbeat/pagamenti. Resta utile
come prova funzionale: 0 failure e 0 tentativi fiscali reali.

## Decisione

Promosso. La modifica e' conservativa, testata, riduce il lavoro inutile quando
arrivano duplicati `ready` status-only e migliora il canary comparabile senza
introdurre failure.

Non chiude ancora il gate P3: i p95 ordine restano nell'ordine degli 8-9 s,
lontani dalla soglia intermedia da 500 ms. La latenza residua e' ancora dominata
dall'attesa in `orderLane`; il prossimo step deve continuare su isolamento degli
outlier/coda o su ulteriori tagli prima dell'ingresso in lane.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_ready_status_noop_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_ready_status_noop_smoke_20/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_ready_status_noop_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_ready_status_noop_canary12_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_ready_status_noop_canary12_50_nogui/report.json`
- `logs/loadtest-phaseP_interinale_p3_ready_status_noop_canary12_50_nogui/REPORT.md`
