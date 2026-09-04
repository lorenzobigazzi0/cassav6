# Fase C - Stampa Async

Data: 2026-06-30
Sorgente: `estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`

## Scopo

Seguire la Fase C della roadmap `ROADMAP_REALTIME_CASSAV4.md`: impedire che la stampa rallenti le operazioni interattive e togliere il worker spool dalla coda globale quando possibile.

## Stato Trovato

Il path ordine principale era gia' parzialmente asincrono: dopo `writeIntegrationOrderDb` schedula l'auto-print in background e risponde al client. La parte ancora problematica era il worker spool: `claimNextPrintSpoolJob` e `completePrintSpoolJob` passavano da `withDbMutation`, quindi ogni claim/complete occupava la coda globale.

## Modifiche

- Aggiunto flag `PRINT_SPOOL_FAST_WORKER=1`.
- Esteso `mysql-domains-split.repository.js` con `syncDomainArrayEntriesFromAppState`, per aggiornare una sola voce di un array top-level.
- Aggiornato il worker stampa:
  - claim veloce di un job `printSpoolJobs` senza `withDbMutation`;
  - complete veloce di un job `printSpoolJobs` senza `withDbMutation`;
  - fallback automatico al vecchio path se il fast path non e' disponibile o fallisce.
- Abilitato il flag nello script `tools/restart-cassav4-linux.sh`.
- Abilitato il flag negli harness load/endurance.

## Verifica

Test:

- `node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js`
- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/scripts/loadtest-full-capacity.mjs`
- `node --check cassa-frontend/scripts/endurance-sim-50k.mjs`
- `node --check cassa-frontend/backend/tests/print-spool-fast-worker.mysql.test.mjs`
- `node --test cassa-frontend/backend/tests/app-state-repository.test.mjs` -> 30/30 pass
- `node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs` -> 8/8 pass
- `node --test cassa-frontend/backend/tests/print-spool-fast-worker.mysql.test.mjs` -> 1/1 pass, con stampante TCP simulata locale e backend MySQL isolato

Mini-load 25 palmari / 5 postazioni, stampa fisica disabilitata:

| Run | Esito | writeDb | dirty externalized | writeComparable p95 | Durata | DB written | Failure |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| `phaseA2_25_2026063001` | A completa | 200 | 200 | `<=1024B` | 49s | 56.32MB | 0 |
| `phaseC2_25_2026063001` | A+C2 regressione | 184 | 184 | `<=1024B` | 46s | 51.04MB | 0 |

Report:

- `logs/loadtest-phaseC2_25_2026063001/REPORT.md`
- `logs/loadtest-phaseC2_25_2026063001/report.json`

## Esito

La regressione generale e' pulita e il fast path app-state resta al 100%.

Il test end-to-end dedicato avvia una stampante TCP simulata locale con `PRINTING_ENABLED=1`, invia `/api/integration/print`, attende i byte ESC/POS ricevuti, verifica lo stato job `printed` nella tabella domini MySQL e controlla che le metriche runtime non contengano label `print_spool_*` nella coda globale. C2 e' quindi validata senza stampanti fisiche.

## Residuo

Resta da completare C1/C3 sul lato UX/client per eventuali flussi che chiamano manualmente `/api/integration/print`: oggi il worker e' fuori dalla coda, ma la route manuale restituisce ancora dopo l'enqueue del job. La fase D puo' comunque partire: il prossimo guadagno percepito e' far portare dati veri agli eventi realtime invece del solo `refresh`.
