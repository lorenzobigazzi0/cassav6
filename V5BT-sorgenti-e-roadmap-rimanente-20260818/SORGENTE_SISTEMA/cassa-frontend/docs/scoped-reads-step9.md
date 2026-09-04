# Scoped Reads - Step 9A

## Scope

Step 9A introduces read-only scoped endpoints without changing existing
frontend callers yet.

## Endpoints

```text
GET /api/tables/:tableId
GET /api/tables/:tableId/open-order
GET /api/rooms/:roomId/tables
GET /api/notifications
GET /api/print/jobs/:jobId
```

The new endpoints are additive. Existing legacy endpoints such as
`/api/integration/layout`, `/api/integration/notifications/pull`, and
`/api/integration/orders` remain available.

## Flag

```env
SCOPED_READS=1
```

Rollback:

```env
SCOPED_READS=0
```

## Fallback Visibility

Responses include:

```json
{
  "meta": {
    "scopedRead": true,
    "source": "scoped",
    "fullStateFallbackUsed": false
  }
}
```

If split/scoped persistence is unavailable the endpoint falls back to the
legacy full app-state read and returns `fullStateFallbackUsed: true`.

## Security Note

The first scoped endpoints are public read-only for parity with the existing
public operational endpoints (`/api/integration/layout`,
`/api/integration/orders`, and `/api/integration/notifications/pull`). This
avoids the current auth policy path, which still validates sessions through a
full app-state read before route dispatch.

Before replacing authenticated frontend reads with these paths, add a scoped
session validator that reads only the split sessions/users records.
