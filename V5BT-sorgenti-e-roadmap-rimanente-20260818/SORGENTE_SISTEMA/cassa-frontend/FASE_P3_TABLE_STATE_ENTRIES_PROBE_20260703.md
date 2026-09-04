# Fase P3 - Probe tableState entries

Data: 2026-07-03

## Obiettivo

Verificare il filone indicato da `FASE_P3_ORDER_MYSQL_BATCH_PROBE_20260703.md`:
ridurre il costo di `orders.create.mysql.posSettingsTables` e
`orders.sync.mysql.posSettingsTables` evitando un full sync dello split
`tableState` quando e' noto l'ID del tavolo aggiornato.

## Modifica provata

E' stato prototipato `syncEntriesFromAppState(appState, tableIds)` in
`table-state-split.repository.js` e collegato a `syncPosSettingsTablesFastPath`.

Il prototipo:

- aggiornava solo gli ID tavolo selezionati nello split SQLite `tableStates`;
- manteneva il checksum dominio calcolato dall'app-state in memoria;
- lasciava fallback completo per layout e casi senza ID.

## Verifiche tecniche

Prima del canary:

- `node --check cassa-frontend/backend/server.js`: OK
- `node --check cassa-frontend/backend/db/app-state/table-state-split.repository.js`: OK
- test mirati `app-state-repository`, `route-policy-architecture`,
  `runtime-metrics`: 86/86 pass

## Smoke 20

Run: `phaseP_interinale_p3_table_state_entries_smoke_20`

Confronto con `phaseP_interinale_p3_waiter_pause_scope_smoke_20`:

- durata: 78,5 s -> 69,3 s
- business ops: 600 -> 600
- failure: 0 -> 0
- HTTP response: 15,71 MB -> 10,34 MB
- `orders.create.mysql.posSettingsTables` avg: 53,31 ms -> 49,87 ms
- `orders.sync.mysql.posSettingsTables` avg: 37,11 ms -> 41,55 ms

Lo smoke era abbastanza pulito per procedere a canary.

## Canary 50 non comparabile

Run: `phaseP_interinale_p3_table_state_entries_canary_50`

Nota: questo run non e' confrontabile con il canary 8 storico perche' non aveva
`ORDER_SYNC_FAST_LANE_CONCURRENCY=8` forzato.

Esito comunque utile:

- durata: 201,5 s
- business ops: 1200
- failure: 0
- retry/deadlock: 0 nel campione cercato

## Canary 8 corretto

Run: `phaseP_interinale_p3_table_state_entries_canary8_50`

Env rilevante:

- `ORDER_SYNC_FAST_LANE_CONCURRENCY=8`
- `ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY=8`
- stampa fisica e fiscale reale disabilitati

Confronto con `phaseP_interinale_p3_order_bucket_cache_canary_50`:

| Metrica | Baseline canary 8 | Probe tableState entries |
|---|---:|---:|
| Durata | 198,4 s | 206,5 s |
| Business ops | 1260 | 1200 |
| Failure | 0 | 0 |
| `order.create` p95 | 14.678 ms | 22.547 ms |
| `order.sync.ready` p95 | 14.890 ms | 23.552 ms |
| `order.sync.delivered` p95 | 14.817 ms | 23.777 ms |
| `orders.create.mysql.posSettingsTables` avg | 137,1 ms | 156,52 ms |
| `orders.sync.mysql.posSettingsTables` avg | 88,28 ms | 104,2 ms |
| `orders.sync.mysql.orders` avg | 440,47 ms | 451,95 ms |
| `fiscalRetryLaneEnqueued` | 15 | 0 |

## Decisione

Non promuovere il prototipo.

Motivo: sotto canary 8 il costo locale `posSettingsTables` peggiora e la latenza
end-to-end ordine peggiora nettamente. Il miglioramento nello smoke non si
replica sotto carico.

La patch funzionale e il test sperimentale sono stati rimossi. Il codice runtime
torna al comportamento precedente: `syncPosSettingsTablesFastPath` aggiorna
`posSettings.tables` per ID quando possibile e poi usa `tableStateSplitRepository.syncFromAppState(db)`.

## Prossimo indirizzo

Il prossimo step P3 non deve puntare a `tableState entries` in questa forma.
Restano piu' promettenti:

- ridurre il costo/varianza di `orders.sync.mysql.orders` senza batch cieco;
- verificare se le operazioni `comp/correct` stanno saturando la stessa order lane
  delle create/sync leggere;
- separare o ridurre le route fallback `orders.sync.routeFallback.appStateWrite`.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_table_state_entries_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_table_state_entries_canary_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_table_state_entries_canary8_50/report.json`
