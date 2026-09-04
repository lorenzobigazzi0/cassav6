# Realtime push-first - Step 7

Step 7 chiude il passaggio dal refresh generico allo streaming SSE con envelope
outbox autoritativo.

## Contratto live SSE

Quando `EVENT_OUTBOX_ENABLED=1` e `SSE_EVENT_PAYLOAD=1`, lo stream:

```text
GET /api/integration/notifications/stream
```

emette eventi `payload` con `id:` SSE uguale a `event_outbox.id` e `data:` nel
formato:

```json
{
  "eventId": 42,
  "type": "order.created",
  "aggregateType": "order",
  "aggregateId": "order_1",
  "aggregateVersion": 7,
  "scope": "room_pedana",
  "payload": {
    "ok": true,
    "reason": "order_created",
    "detail": {}
  },
  "createdAt": "2026-07-07T10:00:00.000Z"
}
```

Lo stesso envelope viene restituito da `GET /api/realtime/replay`.

Da Step 12A, per eventi ordine/tavolo `aggregateVersion` viene valorizzato
quando il payload contiene `revision`, `currentRevision` o `aggregateVersion`;
resta `null` per eventi che non hanno una versione aggregato.

## Reconnect

Lo stream accetta:

```text
Last-Event-ID: <eventId>
?lastEventId=<eventId>
?afterEventId=<eventId>
```

e invia gli eventi successivi ancora disponibili. Se il gap non e' recuperabile,
lo stream invia `event: recovery` e il client deve eseguire uno snapshot scoped.

## Refresh legacy

`SSE_LEGACY_REFRESH=1` mantiene anche gli eventi `refresh` legacy.

Nel profilo push-first:

```env
SSE_EVENT_PAYLOAD=1
EVENT_OUTBOX_ENABLED=1
REALTIME_REPLAY_ENABLED=1
SSE_LEGACY_REFRESH=0
CLIENT_PUSH_FIRST=1
CLIENT_WIDE_INVALIDATE_DISABLED=1
```

Rollback:

```env
SSE_LEGACY_REFRESH=1
CLIENT_PUSH_FIRST=0
CLIENT_WIDE_INVALIDATE_DISABLED=0
```

## Client mobile

Il mobile normalizza l'envelope in un payload compatibile con i consumer gia'
esistenti, ma conserva:

- `eventId` per deduplica;
- `aggregateType` e `aggregateId`;
- `aggregateVersion`, quando disponibile, per scartare update vecchi;
- `lastEventId` per riconnettersi senza perdere eventi.

Il flag runtime vive in `mobile-frontend/public/config.json`:

```json
{
  "features": {
    "clientPushFirst": true,
    "wideInvalidateDisabled": true
  }
}
```

## Test

```bash
npm run test:phase7
npm run check:backend
```

Mobile:

```bash
npm run typecheck
npm run test -- realtimeEventEnvelope.test.ts notificationCenterSession.test.tsx
```
