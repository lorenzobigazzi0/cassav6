# Fase P3.45 - Financial sync filtrato sul tavolo target

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Run finale: `p3_45_financial_target_layout_c1_50_20260709`

## Obiettivo

Dopo P3.43/P3.44, `orders/sync` usava gia' snapshot tavolo e sessioni filtrate
nel path layout. Restava pero' un punto nel financial sync:
`syncPosTableFinancialsFromIntegrationOrders()` riceveva `targetTableIds`, ma
costruiva ancora `liveStats`, `currentTableSessions` e layout come se dovesse
ricalcolare tutto.

## Modifica

- `syncPosTableFinancialsFromIntegrationOrders()` ricava `targetOptions` da
  `targetTableIds`.
- `buildIntegrationTableLiveStats()` riceve `targetOptions`.
- `buildIntegrationCurrentTableSessions()` riceve `targetOptions`.
- Quando esiste un target, il layout usato dal financial sync costruisce solo i
  record dei tavoli target con `createIntegrationLayoutRoomResolver()` e
  `buildIntegrationLayoutTableRecord()`.
- Aggiunto test statico P3.45 in `route-policy-architecture.test.mjs`.

File modificati:

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`

Budget `server.js`: `38.794` righe, sotto il limite M5 `38.800`.

## Verifica

Locale:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
```

Esito: 96/96 PASS.

Raspberry:

```bash
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
```

Esito: 96/96 PASS.

Servizi dopo restart: backend owner, worker 5283, worker 5284, realtime,
frontend e battery tutti `active`.

Safety I/O confermata:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

Nota operativa: il primo reset metriche dopo restart ha ricevuto un 502 dal
frontend durante il warm-up. Backend e worker hanno poi risposto 200 e il reset
metriche e' stato ripetuto con successo prima del canary.

## Canary 50

| Metrica | P3.44 | P3.45 targetOptions | P3.45 finale |
| --- | ---: | ---: | ---: |
| Esito | PASS | PASS | PASS |
| OK | 50/50 | 50/50 | 50/50 |
| Durata | 117515.87 ms | 121772.02 ms | 125448.43 ms |
| create p95 | 732.06 ms | 705.62 ms | 713.22 ms |
| sync p95 | 791.95 ms | 868.53 ms | 928.36 ms |
| readback p95 | 372.93 ms | 317.73 ms | 290.55 ms |
| cleanup p95 | 245.11 ms | 298.49 ms | 245.84 ms |

Il passo e' funzionalmente verde e migliora il readback rispetto a P3.44, ma
non migliora `sync p95`. Il dato va letto come evidenza: il collo residuo del
sync non e' risolto dal filtraggio financial/layout, oppure la crescita dei dati
storici tra run sta dominando il confronto.

## Runtime metrics P3.45 finale

| Contatore | Valore |
| --- | ---: |
| `writeDb` | 0 |
| `readDb` | 623 |
| `eventOutboxPublishRuns` | 100 |
| `eventOutboxPublished` | 183 |
| `eventOutboxPublishFailed` | 0 |
| `eventOutboxBacklogMetricRefreshes` | 30 |
| `eventOutboxBacklogMetricSkips` | 573 |
| `mqttPublishQueued` / `mqttPublishConfirmed` | 183 / 183 |
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

P3.45 chiude un altro full-scan non necessario nel path finanziario del tavolo
target e resta stabile sotto canary 50, senza backlog, retry o fallback.

Non chiude il gate latenza: `sync p95` e' ancora sopra 500 ms e peggiora rispetto
al run P3.44. Il prossimo step consigliato e' P3.46: aggiungere metriche
granulari interne a `handleIntegrationOrderSync()` o profilare di nuovo il
worker post-P3.45, per distinguere costo di:

- relational write/snapshot/guard;
- financial sync;
- payload realtime/outbox;
- `writeIntegrationOrderSyncDb`;
- risposta JSON.

Senza questa visibilita', altri fast path rischiano di essere corretti ma non
centrati sul collo reale.

## Artifact

- Canary finale report: `reports/p3_45_financial_target_layout_20260709/REPORT.md`
- Canary finale result JSON: `reports/p3_45_financial_target_layout_20260709/result.json`
- Runtime metrics finale: `reports/p3_45_financial_target_layout_20260709/p3-45b-runtime-metrics.json`
- Export finale compresso: `reports/p3_45_financial_target_layout_20260709/cassav4-p3-45b-export.tgz`
- Primo run targetOptions: `reports/p3_45_financial_target_20260709/`
