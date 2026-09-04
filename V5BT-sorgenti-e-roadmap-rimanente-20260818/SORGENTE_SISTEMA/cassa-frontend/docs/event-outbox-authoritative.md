# Event outbox autoritativa — Step 5

Rende gli eventi realtime dei piloti **durabili, ordinati e replayabili** dall'event
outbox relazionale, così che nessun evento critico viva solo in memoria. Costruisce
sull'infrastruttura outbox esistente (FASE_H) senza riscriverla.

## Eventi pilota emessi

| Evento | Origine | Aggregate | Payload |
|---|---|---|---|
| `notification.acked` | `POST /api/integration/notifications/ack` (ack riuscito) | `notification` / id | `{ id, action, consumer, type, orderId }` |
| `print.requested` | `POST /api/integration/print` (ristampa comanda/preconto di un ordine esistente) | `order` / orderId | `{ kind, orderId }` |

`print.status` è rimandato allo Step 6 (Print Async Durable), dove si tocca lo spool.

L'emissione è **durabile e best-effort**: l'append all'`event_outbox` è atomico
(id AUTOINCREMENT monotono = sequenza globale) ma non fa mai fallire la richiesta
business; se fallisce si logga e si contano le metriche. **Sinergia con lo Step 4**:
con la command inbox in `enforce_pilot` i retry idempotenti fanno short-circuit
prima dell'handler, quindi ogni evento è emesso **esattamente una volta**.

## Replay / catch-up: `GET /api/realtime/replay`

Dietro flag `REALTIME_REPLAY_ENABLED` (404 `REALTIME_REPLAY_DISABLED` se spento).
Serve il catch-up dopo un reconnect leggendo l'outbox durabile.

```text
GET /api/realtime/replay
Header: Last-Event-ID: <eventId>     (oppure ?afterEventId=<eventId>)
Opzionale: ?limit=<n>  (default 200, max 1000)
```

Risposta normale:

```json
{
  "ok": true,
  "recoveryRequired": false,
  "events": [
    {
      "eventId": 42,
      "type": "notification.acked",
      "aggregateType": "notification",
      "aggregateId": "n-123",
      "aggregateVersion": null,
      "scope": null,
      "payload": { "id": "n-123", "action": "ack", "consumer": "mobile-frontend" },
      "createdAt": "2026-07-06T10:00:00.000Z"
    }
  ],
  "lastEventId": 42,
  "maxEventId": 42
}
```

Envelope conforme a `contracts/event-envelope.schema.json`. Gli `eventId` sono
monotoni crescenti: il client tiene l'ultimo applicato e ignora quelli già visti
(dedup lato client, per `contracts/sse-replay-contract.md`).

Gap troppo grande (il `Last-Event-ID` del client è più vecchio del più vecchio
evento ancora in outbox, già potato dalla retention):

```json
{ "ok": true, "recoveryRequired": true, "minEventId": 30, "maxEventId": 90, "events": [] }
```

→ il client esegue uno snapshot scoped invece del replay incrementale.

Nota: lo streaming SSE push-first completo è lo **Step 7**; qui c'è solo il
catch-up/replay durabile + l'emissione degli eventi.

## Feature flag

Aggiornamento Step 7: lo stream SSE push-first usa lo stesso envelope del replay
quando gli eventi arrivano da `event_outbox`. Vedi `docs/realtime-push-first.md`.

```env
EVENT_OUTBOX_ENABLED=1       # abilita append+publisher+emissione eventi (già esistente)
REALTIME_REPLAY_ENABLED=1    # abilita GET /api/realtime/replay
```

Rollback: spegnere i flag. Con `EVENT_OUTBOX_ENABLED=0` gli eventi non vengono
emessi e il sistema resta sul refresh legacy; con `REALTIME_REPLAY_ENABLED=0`
l'endpoint di replay risponde 404.

## Metriche

Sezione `realtimeBackbone` dello snapshot `GET /api/monitor/runtime-metrics`:
`outboxUnpublished` (pendingEvents), `outboxLagMs` (publishLag), `pilotEventsEmitted`,
`pilotEventsFailed`, `replayRuns`, `replayEvents`, `replayRecoveries`. Il tempo di
insert è registrato via `recordOperation("eventOutbox", "insert", ms)`.

## Limiti noti

- Owner-only: outbox, publisher ed emissione vivono sull'owner (coerente con la
  topologia multiprocesso e con lo Step 4). In multiprocesso il proxy deve
  instradare `/api/realtime/replay` all'owner (le read scalano ai worker solo se
  `canScaleReadRoutes`; ogni worker avrebbe un proprio outbox).
- `print.status` fuori scope (Step 6). Pagamenti/fiscale/order.create non toccati.
- MySQL resta la fonte di verità; l'outbox relazionale è il log eventi durabile.

## Test

```bash
npm run test:phase5        # unit replay repo/coordinator + e2e pilota (boot isolato)
npm run check:backend
node --test backend/tests/realtime-backbone.test.mjs backend/tests/realtime-event-outbox.e2e.test.mjs
```
