# Fase H4 - Retention e metriche event outbox

Data: 2026-07-01

## Obiettivo

Chiudere la Fase H rendendo operativo il backbone `event_outbox` anche nel tempo:

- evitare crescita indefinita delle righe gia' pubblicate;
- rendere visibile la pressione dell'outbox nei runtime metrics;
- mantenere invariati flag, compatibilita' SSE e fallback inline gia' introdotti in H3.

## Configurazione

Nuove variabili:

```bash
EVENT_OUTBOX_RETENTION_HOURS=24
EVENT_OUTBOX_RETENTION_INTERVAL_MS=3600000
```

Restano attivi i flag strutturali gia' introdotti:

```bash
EVENT_OUTBOX_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
```

## Interventi

### Repository

`EventOutboxRepository` ora espone:

- `countSummary()`;
- `deletePublishedBefore(publishedBeforeIso)`.

Il cleanup elimina solo righe con `published_at IS NOT NULL` piu' vecchie del cutoff, lasciando intatti gli eventi non pubblicati o falliti da ritentare.

### Coordinator

`createEventOutboxCoordinator()` ora supporta:

- `metrics`;
- `retentionHours`;
- `retentionIntervalMs`;
- `cleanupPublished()`.

Il worker periodico H3c continua a drenare l'outbox e, a intervalli di retention separati, pulisce le righe gia' pubblicate.

### Runtime metrics

Nuovi counter:

- `eventOutboxPublishRuns`;
- `eventOutboxPublished`;
- `eventOutboxPublishFailed`;
- `eventOutboxRetentionRuns`;
- `eventOutboxRetentionDeleted`;
- `eventOutboxRetentionErrors`.

Nuove gauge:

- `eventOutboxUnpublished`;
- `eventOutboxPublishedRows`;
- `eventOutboxFailedUnpublished`.

## Test aggiunti/aggiornati

In `realtime-backbone.test.mjs`:

- esteso il test repository con `countSummary()` e `deletePublishedBefore()`;
- aggiunto `EventOutboxCoordinator aggiorna metriche runtime publish e retention`.

In `runtime-metrics.test.mjs`:

- assert sui nuovi counter/gauge event outbox;
- reset verificato anche per le nuove metriche.

## Verifiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/realtime-backbone/event-outbox.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/realtime-backbone.repo.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/realtime-backbone.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/runtime-metrics.test.mjs
```

Esito: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
```

Esito:

```text
tests 7
pass 7
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-event-outbox.e2e.test.mjs
```

Esito:

```text
tests 4
pass 4
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
```

Esito:

```text
tests 16
pass 16
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/notification-stream-payload.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/orders-payments-invariants.test.mjs
```

Esito:

```text
tests 16
pass 16
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

`backend/server.js`: 40.394 righe, sotto il budget G1 di 40.500.

## Stato Fase H

Fase H completa a livello di fondamenta:

- H1 schema `idempotency_keys` + `event_outbox`;
- H2 idempotency store sui pagamenti principali;
- H3 outbox realtime generico con worker e ripartenza backend;
- H4 retention + metriche.

La parte ancora volutamente fuori scope e' il write-primary relazionale completo dei domini: quello parte dalla Fase I.

## Prossimo step

Fase I0: verifica automatica di equivalenza shadow ordini/app-state prima di promuovere qualunque path a read/write-primary relazionale.
