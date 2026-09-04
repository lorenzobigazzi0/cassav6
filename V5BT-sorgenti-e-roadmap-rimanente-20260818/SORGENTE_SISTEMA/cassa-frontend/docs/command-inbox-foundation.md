# Command inbox foundation — Step 3

Questa fase aggiunge una base generica per trasformare le azioni critiche del POS in comandi idempotenti, versionabili e misurabili.

## Obiettivo

Preparare il sistema a rimuovere progressivamente la coda globale senza introdurre doppioni da retry, doppio tap o reconnect.

La semantica business non cambia in questo step: nessun handler ordini/pagamenti/tavoli viene spostato automaticamente sulla command inbox. La nuova tabella e il repository sono una fondazione dietro flag.

## Flag

```env
COMMAND_INBOX_ENABLED=0|1
COMMAND_INBOX_MODE=off|shadow|write|enforce
```

Modalità consigliata ora:

```env
COMMAND_INBOX_ENABLED=1
COMMAND_INBOX_MODE=shadow
```

`shadow` significa: introdurre contratti, test, migrazione, metriche e wrapper disponibili, ma senza rendere la command inbox obbligatoria per i flussi POS esistenti.

## Tabella

Migrazione aggiunta:

```text
backend/db/relational/migrations/018_command_inbox.sql
```

Tabella principale:

```text
command_inbox
```

Campi chiave:

- `request_id`: identificativo univoco della richiesta client;
- `idempotency_key`: chiave anti-doppione stabile per device/comando;
- `device_id`, `user_id`, `station_id`;
- `command_type`;
- `aggregate_type`, `aggregate_id`;
- `expected_version`;
- `payload_hash`;
- `payload_json`;
- `status`: `processing`, `committed`, `rejected`, `failed`;
- `result_json`;
- `error_code`;
- timestamp e scadenza.

## Repository

Nuovo repository:

```text
backend/db/relational/command-inbox.repo.js
```

Export da:

```text
backend/db/relational/index.js
```

API principali:

```js
const repo = new CommandInboxRepository(db, { runtimeMetrics });

const claim = repo.begin({
  requestId,
  idempotencyKey,
  deviceId,
  userId,
  commandType: "orders.create",
  aggregateType: "order",
  aggregateId,
  expectedVersion,
  payload,
});

repo.commit(requestId, { orderId, version });
repo.reject(requestId, "ORDER_ALREADY_PAID", { message: "..." });
repo.fail(requestId, "UNEXPECTED_ERROR", { message: "..." });
```

## Stati `begin`

`begin()` ritorna:

- `created`: primo arrivo del comando, eseguire handler;
- `processing`: retry arrivato mentre il comando precedente è ancora in corso;
- `committed`: replay sicuro di risultato già committato;
- `rejected`: replay sicuro di rigetto business;
- `failed`: replay di failure;
- `conflict`: stessa idempotency key/request con payload incompatibile.

## Regole

1. Ogni comando critico deve avere `requestId` e `idempotencyKey`.
2. `payload_hash` è SHA-256 su JSON stabile.
3. Stessa idempotency key con payload diverso è un conflitto, non un retry.
4. Il pagamento definitivo, fiscale e saldo ordine restano in MySQL transazionale.
5. Redis può essere usato solo come deduplica temporanea, non come verità.
6. MQTT commands non vanno abilitati senza command inbox.

## Metriche

Aggiunti contatori runtime:

- `commandInboxClaims`;
- `commandInboxCreated`;
- `commandInboxReplays`;
- `commandInboxConflicts`;
- `commandInboxInProgress`;
- `commandInboxCommitted`;
- `commandInboxRejected`;
- `commandInboxFailed`.

Dashboard runtime espone una sezione `commandInbox`.

Analisi snapshot:

```bash
npm run command:inbox:analyze
```

Genera:

```text
reports/command-inbox-summary.json
reports/command-inbox-summary.md
```

## Cutover futuro

Ordine suggerito:

1. `notification.ack`;
2. `print.request`;
3. `tables.occupy/release`;
4. `orders.create/addItems`;
5. `payments.settle` solo dopo test di conflitto/versioning;
6. MQTT commands solo dopo `command_inbox` stabile.
