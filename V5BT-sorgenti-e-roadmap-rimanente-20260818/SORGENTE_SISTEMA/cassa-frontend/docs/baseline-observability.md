# Baseline observability — Fase 0

## Flag

Per abilitare NDJSON diagnostico:

```bash
RUNTIME_METRICS=1
DIAGNOSTICS_BASELINE=1
DIAGNOSTICS_LOG_JSON=0
DIAGNOSTICS_SAMPLE_RATE=1
DIAGNOSTICS_BASELINE_LOG_PATH=backend/logs/performance-baseline.ndjson
```

`DIAGNOSTICS_LOG_JSON=1` duplica gli eventi su stdout. In sviluppo è utile; in produzione/lab può essere rumoroso.

## Evento registrato per request

Il backend ora registra, quando `DIAGNOSTICS_BASELINE=1`:

- `requestId`;
- metodo/path/route;
- status;
- `responseMs`;
- `queueWaitMs` e `laneWaitMs` dove correlabili;
- `handlerRunMs` stimato;
- `readDbCount`;
- `readDbMs`;
- `writeDbCount`;
- `writeDbMs`;
- `queueWaitMs`, quando la request passa dalla coda globale;
- `laneWaitMs`, quando la request passa da lane ordini/pagamenti/stanze custom;
- `handlerRunMs` stimato;
- `dirtyDomains`, quando disponibili;
- user/device/station id tecnici, senza token.

Le metriche aggregate di queue/lane continuano a essere raccolte anche dal sistema `runtimeMetrics` esistente. Le lane generiche (`createSerializedMutationLane`) restano disponibili come metriche aggregate; il dettaglio per-request è stato collegato ai path custom principali.

## Parsing

Dopo un test:

```bash
npm run baseline:parse
```

Output:

- `reports/baseline-summary.json`
- `reports/baseline-summary.md`

## Baseline minima da raccogliere

- idle 10 minuti;
- 10 palmari;
- 25 palmari;
- 50 palmari;
- stampante online;
- stampante offline;
- profilo standard vs near-realtime.

Non passare alla fase successiva senza confrontare almeno p50/p95/p99 delle route calde.
