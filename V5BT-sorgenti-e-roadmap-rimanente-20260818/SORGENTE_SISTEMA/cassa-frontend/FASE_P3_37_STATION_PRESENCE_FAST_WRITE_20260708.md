# Fase P3.37 - Station Presence Fast Write

Data: 2026-07-08
Target deploy: Raspberry 192.168.0.67
Root target: /opt/cassav4/current/cassa-frontend

## Obiettivo

Ridurre il residuo visibile sulla lane `station-state-lane` dopo P3.36, evitando `writeDb` completo quando la route `/api/integration/stations/state` deve solo persistere presenza postazione e notifiche di disponibilita.

## Implementazione

- Aggiunto `writeIntegrationStationPresenceDb(db, options)`.
- Il nuovo writer usa `syncObjectArrayEntriesAndObjectEntriesFromAppState` su `integration` per:
  - entry puntuali `stationStates`;
  - notifiche nuove generate dal cambio stato;
  - campi oggetto `lastWriteAt`, `stationAvailabilityNotificationState`, `noActiveStationsAlert` quando necessario, `sequence` quando vengono create notifiche.
- Il fast write viene usato solo se non ci sono side effect su sessioni o ordini:
  - `sessionHeartbeatTouched === false`;
  - nessun rebalance, restore, assegnazione pending o assegnazione operatore.
- Se uno di questi vincoli non vale, resta invariato lo slow path `writeDb(... splitDomains: ["integration", "sessions", "auditEvents"])`.
- Aggiunti contatori runtime:
  - `stationStatePresenceFastWrites`;
  - `stationStatePresenceFastFallbacks`.
- Aggiunti guardrail in `route-policy-architecture.test.mjs`.

## Test locali

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/process-topology.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/integration-station-states-domain.test.mjs
```

Esito:

- Syntax check: PASS.
- Architettura/topologia: 103/103 PASS.
- Runtime/station domain: 12/12 PASS.
- `backend/server.js`: 38.773 righe, sotto budget.

## Deploy target

File copiati sul Raspberry:

- `backend/server.js`
- `backend/modules/runtime-metrics.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/runtime-metrics.test.mjs`

Servizi riavviati:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`

Verifica target:

- Architettura/topologia: 103/103 PASS.
- Runtime/station domain: 12/12 PASS.
- Unita fallite systemd: 0.
- Servizi attivi: backend, worker 5283, worker 5284, realtime, frontend, battery.

## Canary target

Vincoli IO reale:

```bash
PRINTING_ENABLED=0
FISCAL_REAL_IO_DISABLED=1
POS_FISCAL_REAL_IO_DISABLED=1
AUTOMATIC_CASH_REAL_ENABLED=0
```

Canary 1:

- Run: `p3_37_station_presence_fast_c1_20_20260708`
- Esito: PASS 20/20
- Durata: 88.845s
- Create p95: 926.21ms
- Sync p95: 1194.25ms
- Cleanup p95: 326.47ms
- Readback p95: 291.68ms
- Nota: primo cleanup `CUCINA` ha restituito 500, secondo tentativo automatico OK, stato finale coerente e nessun lock residuo.

Canary 2 pulito dopo reset metriche:

- Run: `p3_37b_station_presence_fast_c1_20_20260708`
- Esito: PASS 20/20
- Durata: 81.746s
- Create p95: 716.02ms
- Sync p95: 1102.14ms
- Cleanup p95: 516.19ms
- Readback p95: 333.65ms
- Cleanup: primo tentativo OK per entrambe le postazioni, nessun 500.

Confronto con P3.36:

| Run | Create p95 | Sync p95 | Cleanup p95 | Note |
| --- | ---: | ---: | ---: | --- |
| P3.36 | 709.44ms | 1088.96ms | 255.07ms | owner flush deferred |
| P3.37b | 716.02ms | 1102.14ms | 516.19ms | station presence fast write attivo |

## Metriche P3.37b

Owner 5281:

```json
{
  "writeDbFullStateFallback": 0,
  "stationStateLaneEnqueued": 4,
  "stationStatePresenceFastWrites": 4,
  "stationStatePresenceFastFallbacks": 0,
  "ordersAsyncFlushRemoteOwnerHandled": 41,
  "ordersAsyncFlushRemoteOwnerDeferred": 41,
  "ordersAsyncFlushRemoteOwnerSyncFallbacks": 0,
  "ordersAsyncFlushEnqueued": 41,
  "ordersAsyncFlushRetries": 0,
  "ordersAsyncFlushBackpressureSync": 0
}
```

Lane postazioni:

- `POST /api/integration/stations/state` wait p95: 1ms.
- `POST /api/integration/stations/state` run p95 bucket: 500ms.
- Nessun fallback del fast write presenza.

## Valutazione

Il ramo nuovo funziona: la presenza postazione semplice non passa piu dal full `writeDb`, non produce fallback e non lascia lock residui. Il p95 create resta sostanzialmente allineato a P3.36, quindi il collo P3 principale e ancora altrove, non nella persistenza presenza postazioni.

## Prossimo step consigliato

Procedere con il prossimo collo misurato dopo P3.37:

1. Ridurre il costo `auth.login.appStateWrite` e `auth.logout.appStateWrite`, che nel canary P3.37b pesano circa 340-521ms per write e mostrano mismatch dirty tracking sulle sessioni.
2. Spostare login/logout verso persistenza sessioni puntuale gia esternalizzata, evitando full app-state write quando cambia solo una sessione.
3. Mantenere il profilo multiprocesso: owner mantiene job e worker servono mutazioni ordine con write-primary relazionale e async flush owner.
