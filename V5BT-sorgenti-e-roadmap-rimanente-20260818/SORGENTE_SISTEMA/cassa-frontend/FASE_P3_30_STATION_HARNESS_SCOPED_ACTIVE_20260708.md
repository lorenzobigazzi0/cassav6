# Fase P3.30 - canary con postazioni attive e snapshot station autorevole

Data: 2026-07-08
Target: Raspberry `192.168.0.67`

## Obiettivo

Rendere misurabile P3.29 in uno scenario realistico: almeno 2 postazioni attive prima del batch ordini, senza usare stampante, fiscale o cassa automatica reali.

## Implementazione

- Esteso `scripts/order-worker-sync-e2e-batch-canary.mjs`:
  - nuovo env `ORDER_E2E_BATCH_ACTIVE_STATIONS`;
  - login postazione e heartbeat su `/api/integration/stations/state`;
  - `CANARY_STATION` distribuito round-robin ai child;
  - cleanup verificato con spegnimento, logout sessione postazione e lettura `/api/integration/stations/active`.
- Corretto `backend/modules/integration/station-snapshot.handlers.js`:
  - lo scoped read MySQL di `integration.stationStates` e' autorevole anche quando non ci sono postazioni attive;
  - prima il codice ricadeva sul cache/readDb se `scopedActiveStations.length === 0`, quindi poteva mostrare postazioni vecchie ancora online.
- Aggiunto test unitario:
  - `backend/tests/station-snapshot-handlers.test.mjs`

## File modificati

- `scripts/order-worker-sync-e2e-batch-canary.mjs`
- `scripts/order-worker-sync-e2e-batch-canary.test.mjs`
- `backend/modules/integration/station-snapshot.handlers.js`
- `backend/tests/station-snapshot-handlers.test.mjs`

## Verifiche

Eseguite sul target `192.168.0.67`.

- `node --check scripts/order-worker-sync-e2e-batch-canary.mjs`: OK
- `node --check backend/modules/integration/station-snapshot.handlers.js`: OK
- Test:
  - `backend/tests/station-snapshot-handlers.test.mjs`
  - `scripts/order-worker-sync-e2e-batch-canary.test.mjs`
- Risultato test: 5/5 pass
- Servizi dopo deploy: backend, worker 5283/5284, realtime, frontend, battery tutti `active`.

## Canary finale

Run: `p3_30_station_harness_c3_50x_20260708`

- Iterazioni: 50
- Concorrenza: 3
- Postazioni harness: `BAR PRINCIPALE`, `CUCINA`
- Heartbeat harness: 10s
- Create/sync/cleanup/readback: tutti via `api-worker`
- I/O reale disabilitato: `PRINTING_ENABLED=0`, `FISCAL_ENABLED=0`, `AUTOMATIC_CASH_REAL_ENABLED=0`

Risultato:

| Runs | OK | Failed | Create p95 | Sync p95 | Cleanup p95 | Readback p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 50 | 0 | 2523.28 ms | 2333.16 ms | 1544.14 ms | 910.90 ms |

Dettaglio:

- `create` avg 1321.96 ms, p50 1090.63 ms, p99 4434.58 ms
- `sync` avg 1714.39 ms, p50 1650.13 ms, p99 2591.42 ms
- `readback` avg 430.83 ms, p50 401.93 ms, p99 1676.69 ms
- `cleanup` avg 610.14 ms, p50 451.73 ms, p99 1922.11 ms

Report canary:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_30_station_harness_c3_50x_20260708`

## Stato finale

- `/api/integration/stations/active`: `stations: []`
- Cleanup harness: `verified: true`, primo tentativo, `stillActive: []`
- Ordini canary relazionali del run: 50 `cancelled`, 0 attivi
- `app_table_work_locks`: 0
- stationState attive del run: 0
- sessioni canary del run: rimosse dopo verifica
- Log durante finestra canary: nessuna riga `Nessuna postazione attiva` / `no_active_station`.

## Nota tecnica

Il bug trovato nello step non era nel load balancer: la POST di spegnimento postazione persisteva correttamente `active=false`, ma la lettura `/stations/active` poteva ignorare lo scoped read quando il risultato corretto era vuoto e ricadere su cache/process state. La correzione rende il dato split MySQL autorevole anche per l'insieme vuoto.

## Prossimo step consigliato

Con le postazioni attive il `sync p95` e' sceso rispetto al run P3.29 senza postazioni attive, ma resta sopra il target sub-secondo. Il passo successivo e' profilare/abbattere i costi CPU residui nel path sync: audit diff/item progress, route transition e realtime/outbox fan-out.
