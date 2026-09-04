# Fase H1 - Idempotency e outbox centralizzati

Data: 2026-07-01

## Obiettivo

Avviare la fase H della roadmap v3 creando il backbone condiviso per:

- idempotency centralizzata tramite `idempotency_keys`;
- outbox eventi tramite `event_outbox`;
- flag di rollout `IDEMPOTENCY_STORE_ENABLED` e `EVENT_OUTBOX_ENABLED`, spenti di default;
- test automatici prima del wiring sugli endpoint business.

Questo step non cambia ancora il runtime degli endpoint: prepara schema e repository dietro feature flag.

## File principali

- `cassa-frontend/backend/db/relational/migrations/010_realtime_backbone.sql`
- `cassa-frontend/backend/db/relational/realtime-backbone.repo.js`
- `cassa-frontend/backend/modules/realtime-backbone/realtime-backbone.config.js`
- `cassa-frontend/backend/tests/realtime-backbone.test.mjs`

Aggiornati anche:

- `cassa-frontend/backend/db/relational/migrations.js`
- `cassa-frontend/backend/db/relational/index.js`
- `cassa-frontend/backend/tests/relational-shadow.test.mjs`
- `cassa-frontend/backend/tests/relational-migration-script.test.mjs`

## Schema introdotto

`idempotency_keys`:

- chiave primaria: `idempotency_key`;
- `scope`;
- `request_hash` SHA-256;
- `response_json`;
- stato `processing | completed | failed`;
- `created_at`, `updated_at`, `expires_at`;
- indice `idx_idempotency_keys_scope_expires`.

`event_outbox`:

- `id` autoincrementale;
- `event_type`, `aggregate_type`, `aggregate_id`;
- `scope`;
- `scope_sequence` monotono per scope;
- `payload_json`;
- `occurred_at`, `published_at`;
- `publish_attempts`, `last_error`;
- indici `idx_event_outbox_unpublished` e `idx_event_outbox_scope_sequence`.

## Repository

`IdempotencyKeysRepository`:

- `begin(...)`: crea una key `processing`, deduplica retry uguali, segnala `conflict` se stessa key ma payload diverso;
- `complete(...)`: salva risposta e stato `completed`;
- `fail(...)`: salva risposta/errore e stato `failed`;
- riciclo automatico delle key scadute;
- `hashIdempotencyRequest(...)` usa JSON stabile e SHA-256.

`EventOutboxRepository`:

- `enqueue(...)`: inserisce evento e assegna `scope_sequence`;
- `listUnpublished(...)`: lista eventi non pubblicati;
- `markPublished(...)`;
- `markPublishFailed(...)`;
- `countUnpublished()`.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
```

Esito:

```text
tests 6
pass 6
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-shadow.test.mjs
```

Esito:

```text
tests 53
pass 53
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-migration-script.test.mjs
```

Esito:

```text
tests 6
pass 6
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-orders.test.mjs backend/tests/relational-payments.test.mjs backend/tests/relational-tables-bills.test.mjs
```

Esito:

```text
tests 36
pass 36
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

## Stato

H1 completata.

Il prossimo step consigliato e' H2: collegare `IdempotencyKeysRepository` al primo dominio gia' migrato e piu' rischioso per doppi effetti, cioe' i pagamenti, mantenendo `IDEMPOTENCY_STORE_ENABLED=0` di default e aggiungendo test doppio tap/retry rete prima di attivarlo.
