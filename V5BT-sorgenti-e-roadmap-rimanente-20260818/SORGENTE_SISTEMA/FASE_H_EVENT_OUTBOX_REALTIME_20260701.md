# Fase H3b - Event outbox realtime generico

Data: 2026-07-01

## Obiettivo

Estendere il collegamento `event_outbox` oltre `payment.status`, usando lo stesso backbone per tutti gli eventi SSE tipizzati gia' previsti da `SSE_EVENT_PAYLOAD`.

## Flag

Attivazione:

```bash
EVENT_OUTBOX_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
```

`SSE_EVENT_PAYLOAD=1` continua a controllare l'invio dell'evento SSE `payload`; il vecchio evento `refresh` resta compatibile.

## Interventi

- `publishIntegrationNotificationStreamRefresh()` ora passa da `event_outbox` per tutti gli eventi realtime quando `EVENT_OUTBOX_ENABLED=1`.
- Il coordinator e' stato rinominato logicamente da pagamento-only a realtime generico.
- Aggiunti resolver generici per:
  - `aggregate_type`: derivato dal tipo evento (`order`, `table`, `payment`, `notification`, `station`, `print`, `settings`, `system`);
  - `aggregate_id`: prioritizzato per dominio, ad esempio id ordine per `order.*`, id notifica per `notification`, id tavolo per `table.*`;
  - `scope`: sala/tavolo/stazione/utente/device quando presenti.
- Il drain degli eventi pendenti resta sull'apertura di `/api/integration/notifications/stream`.
- Se l'outbox non e' disponibile, il sistema logga l'errore e mantiene il publish inline come fallback operativo.

## Test aggiunti/aggiornati

Nuovo file:

- `cassa-frontend/backend/tests/realtime-event-outbox.e2e.test.mjs`

Copre:

- `order.created` accodato senza client SSE, poi pubblicato e marcato con `published_at`;
- `notification` accodata senza client SSE, poi pubblicata e marcata con `published_at`.

Aggiornato:

- `payments-fiscal.e2e.test.mjs`: il test `payment.status` ora cerca la riga pagamento specifica, perche' con H3b il setup puo' legittimamente accodare anche eventi ordine.

## Verifiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-event-outbox.e2e.test.mjs
```

Esito:

```text
tests 2
pass 2
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
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
```

Esito:

```text
tests 6
pass 6
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

`backend/server.js`: 40.371 righe, sotto il budget G1 di 40.500.

## Stato

H3b completata: `event_outbox` e' ora il percorso comune per gli eventi realtime tipizzati quando il flag e' acceso.

Prossimo step consigliato: H3c, aggiungere un worker periodico leggero per drenare l'outbox anche senza apertura di un nuovo stream e preparare il test di sopravvivenza a riavvio backend.
