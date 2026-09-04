# Fase P3.44 - Current table sessions filtrate per tavolo target

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Run: `p3_44_table_session_target_c1_50_20260709`

## Obiettivo

Dopo P3.43 il path `orders/sync` non ricostruisce piu' tutto il layout per
ottenere la snapshot di un tavolo, ma `buildIntegrationTableLiveStats()`
continuava a chiamare `buildIntegrationCurrentTableSessions()` senza propagare
il filtro del tavolo target.

L'obiettivo di P3.44 e' evitare che i live stats filtrati costruiscano sessioni
per tutti i tavoli quando serve una sola snapshot.

## Modifica

- `buildIntegrationTableLiveStats(db, options)` passa ora `options` anche a
  `buildIntegrationCurrentTableSessions()`.
- `buildIntegrationCurrentTableSessions(db, options)` normalizza i target con
  `normalizeIntegrationTableSnapshotTargets(options)`.
- Se il filtro e' presente, la funzione risolve solo i tavoli target tramite
  `createIntegrationLayoutRoomResolver()` e `buildIntegrationLayoutTableRecord()`.
- Se il filtro non e' presente, il comportamento resta quello precedente:
  costruzione completa da `buildIntegrationLayoutFromSettings()`.
- Test architetturale P3.44 aggiunto per impedire regressioni sul passaggio del
  filtro.

File modificati:

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`

Budget `server.js`: `38.793` righe, sotto il limite M5 `38.800`.

## Verifica

Locale:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
```

Esito: 95/95 PASS.

Raspberry:

```bash
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
```

Esito: 95/95 PASS.

Servizi dopo restart: backend owner, worker 5283, worker 5284, realtime,
frontend e battery tutti `active`.

Safety I/O confermata:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

## Canary 50

| Metrica | P3.42 | P3.43 | P3.44 |
| --- | ---: | ---: | ---: |
| Esito | PASS | PASS | PASS |
| OK | 50/50 | 50/50 | 50/50 |
| Durata | 118418.30 ms | 112533.50 ms | 117515.87 ms |
| create p95 | 729.39 ms | 754.94 ms | 732.06 ms |
| sync p95 | 948.53 ms | 741.54 ms | 791.95 ms |
| readback p95 | 311.73 ms | 303.13 ms | 372.93 ms |
| cleanup p95 | 228.39 ms | 232.81 ms | 245.11 ms |

P3.44 resta verde e mantiene il miglioramento rispetto a P3.42 sullo `sync`
(`-16.5%` circa). Rispetto a P3.43 il run e' piu' lento sullo `sync` di circa
`+6.8%`: il passo va considerato un consolidamento del fast path, non un taglio
netto di latenza misurabile in questo canary.

## Runtime metrics P3.44

| Contatore | Valore |
| --- | ---: |
| `writeDb` | 0 |
| `readDb` | 622 |
| `eventOutboxPublishRuns` | 103 |
| `eventOutboxPublished` | 209 |
| `eventOutboxPublishFailed` | 0 |
| `eventOutboxBacklogMetricRefreshes` | 32 |
| `eventOutboxBacklogMetricSkips` | 598 |
| `mqttPublishQueued` / `mqttPublishConfirmed` | 209 / 209 |
| `authSessionFastWrites` / fallback | 105 / 0 |
| `stationStatePresenceFastWrites` / fallback | 4 / 0 |
| `ordersAsyncFlushBatches` | 99 |
| `ordersAsyncFlushRetries` | 0 |
| `ordersAsyncFlushBackpressureSync` | 0 |
| `ordersAsyncFlushRemoteOwnerSyncFallbacks` | 0 |
| `relationalReadPrimaryFallbacks` | 0 |

Gauges finali:

- `eventOutboxUnpublished=0`
- `eventOutboxLagMs=0`
- `mysqlPoolActiveConnections=0`
- `mysqlPoolPendingAcquires=0`

## Esito

Il path live stats filtrato ora propaga il target anche alle sessioni tavolo,
evitando lavoro completo quando la richiesta riguarda un singolo tavolo.

Il canary resta stabile, senza fallback e senza arretrato outbox/MySQL. La
latenza non migliora ulteriormente rispetto a P3.43, quindi il prossimo step
deve tornare sui costi CPU piu' alti rimasti nel path `orders/sync` o ridurre
fan-out/serializzazioni non ancora visibili dalle metriche aggregate.

## Artifact

- Canary report: `reports/p3_44_table_session_target_20260709/REPORT.md`
- Canary result JSON: `reports/p3_44_table_session_target_20260709/result.json`
- Runtime metrics: `reports/p3_44_table_session_target_20260709/p3-44-runtime-metrics.json`
- Export compresso: `reports/p3_44_table_session_target_20260709/cassav4-p3-44-export.tgz`
