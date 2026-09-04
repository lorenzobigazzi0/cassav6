# Redis Layer - Step 10A

## Scope

Step 10A introduces an optional volatile Redis layer. Redis is never the
source of truth: MySQL/scoped reads remain authoritative.

## Enabled Areas

```text
table:{tableId}:state        -> scoped table read cache
room:{roomId}:tables         -> scoped room tables read cache
table:{tableId}:open-order   -> scoped open order read cache
device:{deviceId}:presence   -> volatile presence heartbeat
device:{deviceId}:session    -> volatile session mirror
```

Actual keys include the configured prefix and cache namespace version, for
example `cassav4:cache:v1:table:table_1`.

## Flags

```env
REDIS_ENABLED=1
REDIS_CACHE_ENABLED=1
REDIS_SESSIONS_ENABLED=1
REDIS_PRESENCE_ENABLED=1
REDIS_LOCKS_ENABLED=0
```

Optional tuning:

```env
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_CACHE_TTL_MS=4000
REDIS_PRESENCE_TTL_MS=30000
REDIS_SESSION_TTL_MS=600000
REDIS_CONNECT_TIMEOUT_MS=1000
REDIS_COMMAND_TIMEOUT_MS=1000
```

## Fallback

Redis errors are swallowed by the volatile adapter and counted in runtime
metrics. HTTP commands continue through MySQL/scoped reads. A Redis cache hit
returns `meta.source: "redis"` and `meta.redisCacheHit: true`; misses keep the
existing scoped/legacy meta.

## Invalidation

The existing integration hot-cache invalidation also bumps the Redis cache
namespace. Old keys expire by TTL. This avoids making every table/order write
know about Redis directly.

## Not Allowed

Do not store definitive payments, fiscal records, progressive numbers, order
balances, or accounting audit only in Redis.

## Rollback

```env
REDIS_ENABLED=0
REDIS_CACHE_ENABLED=0
REDIS_SESSIONS_ENABLED=0
REDIS_PRESENCE_ENABLED=0
```
