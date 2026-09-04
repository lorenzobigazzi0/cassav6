# Fase M2 - station-scoped orders cache

Data: 2026-07-02

## Obiettivo

Ridurre i cache-miss residui su:

- `GET /api/integration/orders?station=...`

La vista postazione fa polling frequente e spesso invia parametri equivalenti
con ordine diverso, alias diversi o parametri rumorosi (`_`, `token`,
`clientApp`, `fullName`). Prima di M2 questi dettagli producevano cache key
diverse e quindi miss evitabili.

## Modifiche

- `backend/modules/integration/scoped-orders-read.js`
  - Aggiunto `buildIntegrationOrdersFastCacheKey()`.
  - La chiave canonica include solo parametri che cambiano davvero la risposta:
    - `station`
    - `orderId`/`id`
    - `roomId`
    - `operatorUserId`/`userId`
    - `operatorUsername`/`username`
    - `deviceUuid`
    - `includeDone`
    - `includeTransferred`
    - `currentSessionOnly`
    - `doneHistoryLimit`/`historyLimit`
  - Il limite storico station-scoped e' normalizzato/clampato e il default 30
    diventa equivalente al limite assente.
  - Parametri rumorosi e non usati dalla risposta non frammentano piu' la cache.

- `backend/server.js`
  - `handleIntegrationOrders()` usa il nuovo builder canonico invece del builder
    generico sui query params raw.
  - Aggiunti contatori runtime:
    - `integrationOrdersFastCacheHits`
    - `integrationOrdersFastCacheMisses`

- `backend/modules/integration/station-orders-reconciliation.js`
  - La riconciliazione asincrona avviata dalla GET station-scoped preserva le
    hot cache quando e' no-op.
  - Se invece assegna/promuove/pruna e quindi cambia dati, la cache continua a
    essere invalidata come prima.

- Test aggiornati:
  - chiave canonica M2;
  - hit/miss reale della fast cache su due poll station-scoped equivalenti;
  - scheduler station-orders cache-preserving quando no-op;
  - guardrail statico sul builder M2 in `server.js`.

## Invarianti mantenuti

- Nessuna equivalenza inventata su `station`: viene riusata la normalizzazione
  operativa esistente.
- I filtri operatore restano separati e sicuri.
- Le richieste con `orderId`/`roomId` non vengono limitate dal default storico,
  come prima.
- La cache viene invalidata quando la riconciliazione produce cambi reali.
- Il read scoped relazionale/app-state split resta fallback-safe.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/scoped-orders-read.test.mjs backend/tests/station-orders-reconciliation.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs
```

Risultato: 38/38 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/station-pause-transfer.e2e.test.mjs backend/tests/continuity.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs
```

Risultato: 99/99 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 987/987 pass.

Durata full run: 790.220 ms, circa 13m10s.

## Verifica operativa consigliata

Nel canary reale controllare:

- `runtimeMetrics.counters.integrationOrdersFastCacheHits`
- `runtimeMetrics.counters.integrationOrdersFastCacheMisses`
- `runtimeMetrics.requests.runMsByRoute["GET /api/integration/orders"].p99`
- `runtimeMetrics.queues.orderLane.waitMsByLabel["GET /api/integration/orders station reconciliation"].p99`

Un polling stabile di postazione dovrebbe mostrare meno miss ripetuti su query
equivalenti e meno invalidazioni causate da riconciliazioni no-op.

## STOP/REVIEW

M2 e' chiusa lato codice e test. Il prossimo passo della Fase M puo' procedere
su M3: isolare i retry fiscali pendenti in una lane/coda dedicata.
