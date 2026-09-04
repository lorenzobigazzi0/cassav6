# Fase P3.43 - Fast path snapshot singolo tavolo

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Run: `p3_43_layout_table_snapshot_c1_50_20260709`

## Obiettivo

Ridurre la CPU worker rimasta dopo P3.42. Il profilo P3.40 indicava costo
alto su:

- `buildIntegrationLayoutSnapshot()`;
- `findIntegrationLayoutTableSnapshot()`;
- `buildIntegrationTableLiveStats()`.

Il problema: per restituire/aggiornare un singolo tavolo il backend
ricostruiva il layout completo.

## Modifica

`findIntegrationLayoutTableSnapshot()` usa ora un fast path dedicato:

- `findIntegrationLayoutTableFromSettings()` risolve solo il tavolo richiesto,
  mantenendo la stessa logica di sala/area del layout completo;
- `buildIntegrationTableOrderStats()` accetta filtri `targetTableIds` e
  `targetRoomNumberKeys`;
- `buildIntegrationTableLiveStats()` accetta gli stessi filtri ed evita i costi
  pesanti per ordini/container non target;
- overlay finanziario estratto in `overlayIntegrationLayoutTableFinancials()`;
- `findIntegrationLayoutTableSnapshot()` non richiama piu'
  `buildIntegrationLayoutSnapshot()`.

Il budget `server.js` resta valido: `38.794` righe, margine `706`.

File modificati:

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`

## Verifica

Eseguito sul Raspberry:

```bash
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
```

Esito: 94/94 PASS.

Canary 50:

| Metrica | P3.42 | P3.43 |
| --- | ---: | ---: |
| Esito | PASS | PASS |
| OK | 50/50 | 50/50 |
| Durata | 118418.30 ms | 112533.50 ms |
| create p95 | 729.39 ms | 754.94 ms |
| sync p95 | 948.53 ms | 741.54 ms |
| readback p95 | 311.73 ms | 303.13 ms |
| cleanup p95 | 228.39 ms | 232.81 ms |

Il miglioramento specifico su `sync p95` e' circa `-21.8%` rispetto a P3.42.

Runtime metrics P3.43:

| Contatore | Valore |
| --- | ---: |
| `writeDb` | 0 |
| `readDb` | 620 |
| `eventOutboxPublishRuns` | 106 |
| `eventOutboxPublished` | 228 |
| `eventOutboxPublishFailed` | 0 |
| `eventOutboxBacklogMetricRefreshes` | 29 |
| `eventOutboxBacklogMetricSkips` | 536 |
| `mqttPublishQueued` / `mqttPublishConfirmed` | 228 / 228 |
| `authSessionFastWrites` / fallback | 105 / 0 |
| `stationStatePresenceFastWrites` / fallback | 4 / 0 |
| `ordersAsyncFlushBatches` | 98 |
| `ordersAsyncFlushRetries` | 0 |
| `ordersAsyncFlushBackpressureSync` | 0 |

## Esito

Il path `orders/sync` non ricostruisce piu' tutto il layout per ottenere la
snapshot del tavolo. Il canary resta verde e il p95 sync migliora in modo
misurabile. Il `create p95` oscilla leggermente verso l'alto, ma il path create
non e' il target principale di questa fase.

## Prossimo step consigliato

P3.44: ridurre il costo residuo di `buildIntegrationCurrentTableSessions()`,
che viene ancora chiamato dentro i live stats filtrati e costruisce sessioni
partendo dal layout. Candidate:

- cache breve delle current table sessions nel singolo request path;
- filtro target anche nella session resolution;
- misurazione con nuovo CPU profile breve dopo P3.43.

## Artifact

- Canary report: `reports/p3_43_layout_table_snapshot_20260709/cassav4-p3-43-export/canary/REPORT.md`
- Canary result JSON: `reports/p3_43_layout_table_snapshot_20260709/cassav4-p3-43-export/canary/result.json`
- Runtime metrics: `reports/p3_43_layout_table_snapshot_20260709/cassav4-p3-43-export/runtime-metrics.json`
- Export compresso: `reports/p3_43_layout_table_snapshot_20260709/cassav4-p3-43-export.tgz`
