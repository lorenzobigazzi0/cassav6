# Fase M1 - hot endpoint outliers

Data: 2026-07-02

## Obiettivo

Ridurre e rendere misurabili gli outlier p99 residui sugli endpoint caldi:

- `POST /api/auth/session/status`
- `POST /api/integration/stations/state`

Questi endpoint vengono chiamati spesso da mobile e postazioni; ogni lettura o
scrittura superflua amplifica la latenza sotto carico.

## Modifiche

- `backend/server.js`
  - `resolveAuthenticatedRequestContext()` salva sulla request il DB gia' letto
    e validato dalla policy auth (`req.__authDb`).

- `backend/auth/auth.handlers.js`
  - `handleAuthSessionStatus()` riusa `req.__authDb` invece di fare una seconda
    `readDb()` immediata sullo stesso payload.
  - Il path persistente resta invariato: quando il heartbeat deve davvero essere
    scritto, il flusso rientra nella lane presenza/station come prima.

- `backend/modules/runtime-metrics.js`
  - Gli histogram snapshot ora espongono anche:
    - `p50`
    - `p95`
    - `p99`
  - Il valore e' stimato dai bucket gia' esistenti, quindi non aumenta la
    cardinalita' ne' conserva campioni raw in memoria.

- `backend/tests/auth-session.e2e.test.mjs`
  - Aggiunto guardrail: `session/status` no-op deve registrare al massimo una
    lettura DB nella metrica route, e zero scritture.

- `backend/tests/runtime-metrics.test.mjs`
  - Aggiunto guardrail sui percentili stimati per route e queue label.

## Invarianti mantenuti

- `auth/session/status` continua a validare sessione, token e deviceUuid.
- Il heartbeat persistente continua a usare `stationStateLane`/presence lane e
  non la coda globale.
- `stations/state` non cambia comportamento funzionale; ora e' meglio
  osservabile tramite `p99` su route e lane.
- I consumer esistenti delle metriche restano compatibili: sono stati aggiunti
  campi, non rimossi campi.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs backend/tests/auth-session.e2e.test.mjs backend/tests/integration-hot-cache-invalidation-static.test.mjs
```

Risultato: 19/19 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/relational-persistence-mode.test.mjs
```

Risultato: 22/22 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 982/982 pass.

Durata full run: 783.945 ms, circa 13m04s.

## Verifica operativa consigliata

Nel canary reale controllare:

- `runtimeMetrics.requests.runMsByRoute["POST /api/auth/session/status"].p99`
- `runtimeMetrics.requests.readDbCountByRoute["POST /api/auth/session/status"].p99`
- `runtimeMetrics.requests.writeDbCountByRoute["POST /api/auth/session/status"].p99`
- `runtimeMetrics.requests.runMsByRoute["POST /api/integration/stations/state"].p99`
- `runtimeMetrics.queues.stationStateLane.waitMsByLabel["POST /api/integration/stations/state"].p99`
- `runtimeMetrics.queues.stationStateLane.runMsByLabel["POST /api/integration/stations/state"].p99`

## STOP/REVIEW

M1 e' chiusa lato codice e test. Il prossimo passo della Fase M puo' procedere
su M2, mantenendo durante il canary L+M il controllo sui p99 appena esposti.
