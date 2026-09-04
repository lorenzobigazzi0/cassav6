# Fase P3.61 - Redis Cache Namespace Bump Coalescing

Data: 2026-07-09
Target: Raspberry `192.168.0.67`
Profilo: test-safe, stampa/fiscale/cassa automatica reale disattivati

## Obiettivo

Ridurre il rumore sotto burst dovuto agli invalidamenti cache Redis. In P3.60 il canary era verde, ma nei log restava un warning `cache namespace bump: Redis command timeout`. Il collo principale non era Redis, pero' quel warning poteva introdurre latenza non deterministica durante i picchi.

## Modifica

- `backend/modules/redis/redis-volatile-store.js`
  - `bumpCacheNamespace()` aggiorna subito la versione locale.
  - Se un `INCR` Redis e' gia' in corso, gli invalidamenti concorrenti vengono coalesced invece di aprire altre connessioni.
  - Il cache bust resta valido: una sola bump Redis e' sufficiente per invalidare il namespace del burst.
- `backend/modules/runtime-metrics.js`
  - aggiunto contatore `redisCacheInvalidationCoalesced`.
  - aggiunta esposizione dashboard `redis.cacheInvalidationCoalesced`.
- `backend/tests/redis-volatile-store.test.mjs`
  - aggiunto test concorrenza: tre invalidamenti concorrenti generano un solo `INCR`.
- `backend/tests/runtime-metrics.test.mjs`
  - aggiunto guardrail sul contatore nuovo.

## Test

- `backend/tests/redis-volatile-store.test.mjs`: 4/4 PASS
- `backend/tests/runtime-metrics.test.mjs`: 6/6 PASS
- `backend/tests/route-policy-architecture.test.mjs`: 110/110 PASS
- Health dopo restart:
  - `https://127.0.0.1:5280/api/health`: 200
  - `http://127.0.0.1:5281/api/health`: 200
  - `http://127.0.0.1:5283/api/health`: 200
  - `http://127.0.0.1:5284/api/health`: 200

## Canary 50

Run: `p3_61_redis_bump_coalesce_c1_50_20260709`

Risultato: 50/50 PASS

| metrica | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| create | 732.60ms | 677.53ms | 1059.25ms | 1140.89ms | 1140.89ms |
| sync | 86.90ms | 63.76ms | 255.51ms | 524.70ms | 524.70ms |
| readback | 358.62ms | 345.22ms | 477.17ms | 554.47ms | 554.47ms |
| cleanup | 379.48ms | 351.53ms | 544.27ms | 667.03ms | 667.03ms |

Confronto P3.60c:

| metrica p95 | P3.60c | P3.61 | delta |
| --- | ---: | ---: | ---: |
| create | 971.39ms | 1059.25ms | +87.86ms |
| sync | 266.46ms | 255.51ms | -10.95ms |
| readback | 528.15ms | 477.17ms | -50.98ms |
| cleanup | 465.77ms | 544.27ms | +78.50ms |

## Runtime Metrics

Redis:

- `redisCacheInvalidations`: 224
- `redisCacheInvalidationCoalesced`: 8
- `redisErrors`: 0
- `redisPresenceTouches`: 103
- `redisSessionWrites`: 103

Worker collection:

- enabled: true
- expected: 2
- collected: 2
- failed: 0

Route p99 top post-canary:

- `POST /api/integration/stations/state`: p99 500ms, max 265ms, count 12
- `POST /api/auth/login`: p99 500ms, max 378ms, count 103
- `POST /api/tables/lock/acquire`: p99 250ms, max 191ms, count 100
- `POST /api/tables/lock/release`: p99 250ms, max 215ms, count 100
- `POST /api/internal/orders/async-appstate-flush`: p99 25ms, max 22ms, count 114

Log warning/error post-canary:

- `post_canary_recent_warnings.txt`: 0 righe
- Nessun nuovo `Redis command timeout` riprodotto.

## Verdict

P3.61 PASS.

Il warning Redis e' stato neutralizzato e il contatore coalesced mostra che il percorso e' stato effettivamente esercitato. Il sync resta stabile e leggermente migliore di P3.60c. Il collo residuo non e' Redis: i prossimi target sono create/login/lock e poi canary con concorrenza maggiore.

## Artefatti

- `reports/p3_61_redis_cache_bump_coalesce_20260709/runtime_metrics_summary.json`
- `reports/p3_61_redis_cache_bump_coalesce_20260709/runtime_metrics.json`
- `reports/p3_61_redis_cache_bump_coalesce_20260709/p3_61_canary_report.tgz`
- `reports/p3_61_redis_cache_bump_coalesce_20260709/post_canary_recent_warnings.txt`

