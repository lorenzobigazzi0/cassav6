# Fase P3.38 - Auth Session Fast Write

Data: 2026-07-08
Target deploy: Raspberry 192.168.0.67
Root target: /opt/cassav4/current/cassa-frontend

## Obiettivo

Rimuovere dal percorso caldo login/logout il full `writeDb` app-state misurato in P3.37 (`auth.login.appStateWrite` circa 340-521ms), mantenendo correttezza multi-processo e revoca dei token precedenti.

## Implementazione

- Aggiunto fast path `writeAuthSessionFastDb(db, options)` lato server.
- Il fast path e attivo solo quando:
  - MySQL split sessioni e attivo;
  - MySQL split audit e attivo;
  - non ci sono modifiche da persistere sul dominio `users`.
- Login:
  - cattura le sessioni rimosse dalla policy di login;
  - upserta puntualmente la nuova sessione;
  - cancella puntualmente le sessioni revocate;
  - sincronizza l'audit appena creato.
- Logout:
  - cancella puntualmente la sessione;
  - sincronizza l'audit appena creato.
- Fallback invariato a `writeDb`, con `deleteSessionIds` esplicito per il login.
- Repository `mysql-sessions-split` esteso con:
  - `syncEntriesFromAppState(appState, sessionIds)`;
  - `deleteSessions(sessionIds)`;
  - `deleteSessionIds` anche dentro `syncFromAppState`.
- Metriche aggiunte:
  - `authSessionFastWrites`;
  - `authSessionFastFallbacks`.

## Test locali

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/auth/auth.handlers.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/app-state/mysql-sessions-split.repository.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/runtime-metrics.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs backend/tests/route-policy-architecture.test.mjs backend/tests/process-topology.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/mysql-sessions-split.repository.test.mjs backend/tests/auth-session.e2e.test.mjs
```

Esito:

- Syntax check: PASS.
- Architettura/topologia: 103/103 PASS.
- Runtime/session repo/auth e2e: 21/21 PASS.
- `backend/server.js`: 38.775 righe, sotto budget.

## Deploy target

File copiati sul Raspberry:

- `backend/server.js`
- `backend/auth/auth.handlers.js`
- `backend/db/app-state/mysql-sessions-split.repository.js`
- `backend/modules/runtime-metrics.js`
- `backend/tests/route-policy-architecture.test.mjs`
- `backend/tests/runtime-metrics.test.mjs`
- `backend/tests/mysql-sessions-split.repository.test.mjs`

Servizi riavviati:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`

Verifica target:

- Syntax check: PASS.
- Architettura/topologia: 103/103 PASS.
- Runtime/session repo: 7/7 PASS.
- Unita fallite systemd: 0.
- Servizi attivi: backend, worker 5283, worker 5284, realtime, frontend, battery.

## Misura Login/Logout

Misura diretta su owner `5281`, 20 login e 20 logout consecutivi:

```json
{
  "loginP95Ms": 186.50,
  "logoutP95Ms": 32.12,
  "authSessionFastWrites": 41,
  "authSessionFastFallbacks": 0,
  "writeDb": 0,
  "writeDbFullStateFallback": 0
}
```

Rispetto a P3.37, il percorso auth non registra piu `auth.login.appStateWrite` durante la misura.

## Canary Target

Vincoli IO reale:

```bash
PRINTING_ENABLED=0
FISCAL_REAL_IO_DISABLED=1
POS_FISCAL_REAL_IO_DISABLED=1
AUTOMATIC_CASH_REAL_ENABLED=0
```

Run:

- `p3_38_auth_session_fast_c1_20_20260708`

Esito:

- PASS 20/20.
- Durata: 58.593s.
- Create p95: 718.33ms.
- Sync p95: 1089.92ms.
- Cleanup p95: 224.63ms.
- Readback p95: 289.24ms.
- Cleanup primo tentativo OK per entrambe le postazioni.
- Nessun lock residuo su `room_attesa_virtuale_t03`.

Metriche owner post-canary:

```json
{
  "authSessionFastWrites": 45,
  "authSessionFastFallbacks": 0,
  "writeDb": 0,
  "writeDbFullStateFallback": 0,
  "stationStateLaneEnqueued": 4,
  "stationStatePresenceFastWrites": 4,
  "stationStatePresenceFastFallbacks": 0,
  "ordersAsyncFlushRemoteOwnerHandled": 40,
  "ordersAsyncFlushRemoteOwnerDeferred": 40,
  "ordersAsyncFlushRemoteOwnerSyncFallbacks": 0,
  "ordersAsyncFlushEnqueued": 40,
  "ordersAsyncFlushRetries": 0,
  "ordersAsyncFlushBackpressureSync": 0
}
```

## Confronto

| Run | Create p95 | Sync p95 | Cleanup p95 | Durata |
| --- | ---: | ---: | ---: | ---: |
| P3.36 | 709.44ms | 1088.96ms | 255.07ms | 92.8s |
| P3.37b | 716.02ms | 1102.14ms | 516.19ms | 81.7s |
| P3.38 | 718.33ms | 1089.92ms | 224.63ms | 58.6s |

## Valutazione

Il collo auth/login e stato tolto dal full app-state write: login/logout usano scritture puntuali sessione/audit, senza fallback nel profilo target. Il canary ordini resta stabile rispetto a P3.36 e migliora la durata complessiva del batch.

## Prossimo step consigliato

Continuare sul prossimo costo misurato:

1. Profilare `orders.asyncFlush.queueWait` e il flush interval a 500ms: e coerente ma pesa sul sync p95.
2. Valutare un drain anticipato/coalescing adattivo sul flush owner, mantenendo il limite anti-backpressure.
3. In alternativa, avviare una misura CPU `--cpu-prof` sul canary 50 per identificare il prossimo top cost sincrono.
