# Fase H3a - Event outbox su payment.status

Data: 2026-07-01

## Obiettivo

Collegare `event_outbox` al primo evento SSE reale, partendo dai pagamenti, senza cambiare il contratto dei client.

## Flag

Attivazione:

```bash
EVENT_OUTBOX_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
```

`SSE_EVENT_PAYLOAD=1` resta il flag esistente per inviare anche l'evento SSE `payload` tipizzato.

## Interventi

- Aggiunto `modules/realtime-backbone/event-outbox.js`.
- `publishIntegrationNotificationStreamRefresh()` ora instrada gli eventi di tipo `payment.status` su `event_outbox` quando `EVENT_OUTBOX_ENABLED=1`.
- Senza client SSE collegati, l'evento resta in `event_outbox` con `published_at = NULL`.
- Quando un client apre `/api/integration/notifications/stream`, il backend drena gli eventi non pubblicati e li invia come SSE mantenendo il formato esistente:
  - evento `payload` se `SSE_EVENT_PAYLOAD=1`;
  - evento `refresh` come prima.
- Gli endpoint pagamento ora pubblicano `payment_completed`/`payment_status_changed`:
  - `POST /api/payments/table`
  - `POST /api/payments/ticket`
  - `POST /api/payments/free-split`

## Limiti dichiarati

Questo e' il primo passo H3a, non il cutover completo:

- l'outbox e' collegato ai pagamenti, non ancora a tutti gli eventi ordine/tavolo/notifiche;
- la persistenza principale dei pagamenti resta app-state con shadow relazionale;
- `event_outbox` viene scritto dopo la persistenza app-state del pagamento, quindi non e' ancora una transazione relazionale unica end-to-end.

Il passo successivo e' estendere lo stesso pattern agli altri eventi realtime e avvicinare il write-primary relazionale dove la roadmap lo richiede.

## Test aggiunti

In `cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs`:

- `event outbox pagamento tavolo conserva e pubblica payment.status su SSE`

Il test verifica che:

- il pagamento tavolo crea una riga `event_outbox` con `event_type = payment.status`;
- senza client SSE la riga resta non pubblicata;
- aprendo lo stream SSE l'evento viene inviato come `payload` tipizzato;
- dopo l'invio `published_at` viene valorizzato.

## Verifiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/realtime-backbone/event-outbox.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/payments-fiscal.e2e.test.mjs
```

Esito: ok.

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
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

`backend/server.js`: 40.326 righe, sotto il budget G1 di 40.500.

## Stato

H3a completata: primo evento realtime (`payment.status`) agganciato a `event_outbox` dietro flag, con drain SSE e test end-to-end.
