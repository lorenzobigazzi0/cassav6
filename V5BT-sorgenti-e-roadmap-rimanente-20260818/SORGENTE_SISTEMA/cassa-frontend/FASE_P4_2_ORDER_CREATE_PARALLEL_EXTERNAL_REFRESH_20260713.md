# Fase P4.2 - Refresh esterni paralleli in orders/create

Data: 2026-07-13

## Stato

Implementazione, test locali e canary A/B 20/50 completati. Il flag resta
default OFF: i canary autorizzano la prosecuzione della validazione, non la
promozione in produzione. Il gate finale resta subordinato alle fasi P4.3-P4.5
e a due load-100 consecutivi entro le soglie della roadmap.

## Obiettivo

Ridurre un round trip seriale nel percorso
`POST /api/integration/orders/create`, eseguendo in parallelo:

- refresh dei lock tavolo MySQL;
- refresh degli stati postazione condivisi.

Il percorso seriale precedente resta il default. Il canary si abilita con:

```text
BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH=1
```

Rollback immediato: lasciare il flag assente oppure impostarlo a `0`.

## Invarianti

- I refresh partono solo dopo la lettura app-state e il refresh sessione.
- Lock e stati postazione lavorano su viste isolate dello snapshot.
- Il merge avviene soltanto dopo il successo di entrambi.
- Un errore conserva la causa originale e indica `orderCreateRefreshStage`.
- Nessun ACK viene anticipato e nessuna scrittura cambia percorso.
- `BACKEND_ORDER_CREATE_TARGETED_LOCK_REFRESH` resta indipendente e default OFF.

## Telemetria

Il runtime espone etichette dedicate e persistenti nel report:

```text
orderCreateRead:appStateRead
orderCreateRead:refreshSessions
orderCreateRead:refreshTableLocks
orderCreateRead:refreshStationStates
orderCreateRead:parallelExternalRefresh
orderCreateRead:refreshSequence
orderCreateInternal:auth
orderCreateInternal:relationalPrimary
orderCreateInternal:appStateWrite
orderCreateInternal:outboxPublish
orderCreateInternal:response
```

Il runner accetta:

```text
LOADTEST_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH=1
```

e registra il valore effettivo in `report.json` e `REPORT.md`.

## Progressione A/B obbligatoria

1. Smoke/canary 20 baseline con flag `0`.
2. Smoke/canary 20 target con flag `1`.
3. Canary 50 baseline e target.
4. Se entrambi migliorano senza regressioni, load-100 A.
5. Restart pulito e load-100 B.

Configurazione da mantenere nei confronti:

```text
LOADTEST_MULTIPROCESS=1
LOADTEST_API_WORKERS=2
LOADTEST_TABLE_LOCK_WORKERS=1
LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT=8
LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE=4
LOADTEST_ORDER_CREATE_TARGETED_LOCK_REFRESH=0
```

Ogni coppia baseline/target deve cambiare soltanto
`LOADTEST_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH` e `LOADTEST_RUN_ID`.

## Risultati A/B

Run validi:

- canary 20 baseline: `p4_parallel_refresh_canary20_baseline_20260713_run2`;
- canary 20 target: `p4_parallel_refresh_canary20_target_20260713_run1`;
- canary 50 baseline: `p4_parallel_refresh_canary50_baseline_20260713_run5`;
- canary 50 target: `p4_parallel_refresh_canary50_target_20260713_run1`.

| Metrica | Canary 20 OFF | Canary 20 ON | Canary 50 OFF | Canary 50 ON |
| --- | ---: | ---: | ---: | ---: |
| HTTP globale p95 | 499 ms | 460 ms | 924 ms | 853 ms |
| `order.create` p50 | 55 ms | 45 ms | 59 ms | 68 ms |
| `order.create` p95 | 82 ms | 80 ms | 125 ms | 120 ms |
| `order.create` p99 | 99 ms | 117 ms | 152 ms | 209 ms |
| `orderCreateInternal:readDb` media | 4,51 ms | 2,72 ms | 6,56 ms | 4,60 ms |
| SSE p95 | 253 ms | 255 ms | 267 ms | 260 ms |
| Failure | 0 | 0 | 0 | 0 |

Nel canary 50 entrambi i run hanno completato 600/600 operazioni business,
100/100 ordini, 50/50 device al target persistito, SSE e radio 50/50 e drain
completo con outbox, print e fiscale problematici a zero. Escludendo flag,
run id, namespace Redis e percorsi DB isolati, la configurazione A/B e identica.

Il target riduce in entrambi i canary il p95 di `order.create` e nel canary 50
porta il bucket p95 di `readDb` da 25 a 10 ms. La coda p99 di `order.create`
peggiora invece in entrambi i confronti; deve essere ricontrollata sui load-100
prima di qualunque promozione. Il monitor RSS/CPU basato su `/proc` non produce
dati attendibili su Windows: il gate risorse resta da eseguire sul target Linux.

Run diagnostici precedenti al baseline 50 valido sono esclusi dal confronto:
avevano un nome variabile errato per il numero di azioni o un falso negativo
Playwright sul relogin postazione. Il runner ora registra blackout/logout nel
report e, se perde l'evento della risposta login, accetta il recovery soltanto
dopo validazione del token da parte del backend.

## Verifiche locali

```text
node --check backend/server.js
node --check backend/modules/integration/order-create-read-refresh.js
node --check scripts/loadtest-full-capacity.mjs
node --check scripts/loadtest-runtime-metrics.mjs
node --test scripts/loadtest-runtime-metrics.test.mjs
node --test --test-concurrency=1 backend/tests/order-create-read-refresh.test.mjs
node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs
node --test --test-concurrency=1 backend/tests/phase-p-validation-preflight.test.mjs
```

Esito corrente:

- regressione focalizzata backend/architettura/flussi ordine: 163/163;
- `npm run check:backend`: superato;
- `npm run smoke:package-runtime`: superato, hardware disabilitato;
- preflight Phase-P su Windows: 10 verdi e 7 dry-run Raspberry/Linux non
  eseguibili per assenza del runtime target.

## Decisione corrente

**GO condizionato per proseguire P4; NO-GO per la promozione del flag.** I due
canary A/B sono verdi sul p95 e sulla correttezza. Prima dei load-100 finali
restano da ridurre gli endpoint fuori soglia di P4.3, classificare la console
GUI di P4.5 e verificare su Linux RSS/CPU e la regressione p99 del create.
