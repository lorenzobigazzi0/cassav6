# FASE G2 - Print spool retention

Data: 2026-07-01

## Obiettivo

Evitare accumulo indefinito di file in `cassa-frontend/backend/.print-spool` dopo la potatura dei record `printSpoolJobs`.

## Implementazione

- Aggiunto modulo `cassa-frontend/backend/modules/print-spool/retention.js`.
- La retention protegge sempre i job non terminali (`queued`, `processing`, retry futuri).
- I file collegati a job terminali sono cancellabili solo oltre soglia.
- I file non referenziati da alcun job sono trattati come orfani e cancellabili solo oltre soglia.
- Startup backend: recovery spool, retention, poi avvio worker.
- Timer periodico di retention abilitato anche quando `PRINTING_ENABLED=0`.
- Metriche runtime:
  - `gauges.printSpoolOrphanFiles`
  - `counters.printSpoolRetentionRuns`
  - `counters.printSpoolRetentionDeletedFiles`
  - `counters.printSpoolRetentionErrors`

## Configurazione

- `PRINT_SPOOL_RETENTION_ENABLED=0` disabilita la retention.
- `PRINT_SPOOL_RETENTION_TERMINAL_HOURS`, default `24`.
- `PRINT_SPOOL_RETENTION_ORPHAN_HOURS`, default `24`.
- `PRINT_SPOOL_RETENTION_INTERVAL_MS`, default `3600000`.
- `PRINT_SPOOL_ORPHAN_ALERT_THRESHOLD`, default `500`.

## Pulizia retroattiva

Nella copia sorgente corrente non risultavano record print-spool nel DB split locale e non c'erano backend attivi.
I `3700` file presenti in `.print-spool` erano quindi orfani rispetto alla copia corrente.

Risultato pulizia retroattiva:

- file iniziali: `3700`
- orfani rilevati: `3700`
- cancellati: `3700`
- errori: `0`
- file residui: `0`

## Verifiche

- `node --check backend/server.js`
- `node --check backend/modules/print-spool/retention.js`
- `node --check backend/modules/runtime-metrics.js`
- `node --test backend/tests/print-spool-retention.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/architecture-line-budget.test.mjs`
- `node scripts/backend-release-gate.mjs`

Esito: OK.

Nota: `node scripts/package-preflight.mjs --source` non e' applicabile direttamente a questa root estratta perche' si aspetta il layout package `v2/app/...`; ha fallito per file obbligatori assenti di quel layout, non per la print-spool.
