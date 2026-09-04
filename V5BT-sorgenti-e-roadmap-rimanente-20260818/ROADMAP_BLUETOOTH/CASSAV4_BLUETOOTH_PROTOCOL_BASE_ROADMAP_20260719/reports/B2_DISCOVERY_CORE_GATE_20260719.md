# V5BT B2 Discovery Core Gate Report

## Scope

- Phase: B2 - Automatic BLE discovery
- Evidence date: 2026-07-19
- Scope: shared/offline discovery state and scan-window scheduling
- Decision: SHARED CORE PASS; PHYSICAL B2 GATE PENDING

This increment is deliberately transport-independent. It does not start scan or
advertising, access Android/BlueZ, deploy to Raspberry, modify V4, or associate
an advertisement with a stable identity.

The wire UUID and the `CASSAV4-BT-ALIAS-V1` HMAC context remain unchanged for
B1 protocol compatibility while the copied product is named V5BT.

## Peer directory decision

`shared/discovery/peer-directory-v1.mjs` consumes only the 10-byte Service Data
payload and delegates validation to the frozen B1 decoder. Streams are keyed by
`(rotatingAlias, bootId)`.

Accepted rules:

| Rule | Frozen value |
| --- | --- |
| RSSI floor | `-88 dBm`, inclusive |
| Fresh | age `< 5000 ms` |
| Aging | age `5000..15000 ms`, inclusive |
| Expired | age `> 15000 ms` |
| Capacity | 1024 concurrent streams |
| Automatic prune cadence | at most one full pass every `1000 ms` |
| New anonymous streams | at most `2048` attempts per `10000 ms`, rejects included |
| Capacity replacement | aging peer or incoming RSSI at least `6 dB` stronger |
| Identical duplicate | refresh `lastSeen` and RSSI |
| Same sequence, changed semantics | reject conflict, no refresh |
| Newer sequence | replace semantics and refresh |
| Older or half-range ambiguous | reject, no refresh |
| Different alias or boot | coexist as separate streams |

Expired entries are removed before a new stream is capacity-checked. Full-map
pruning is cadence-limited; the observed key still receives an O(1) expiry
check. Accepted refreshes maintain LRU order, so the oldest candidate is found
without a full scan per observation. At capacity, that candidate can be
replaced only if it is already aging or the incoming signal is at least 6 dB
stronger. New anonymous stream attempts, including rejects, are rate-limited.
After expiry, the first valid observation recreates the stream without
comparing against stale sequence state. The clock is injected and a backwards
movement is rejected and counted.

No NodeId, device certificate, authorization result, MAC address or other stable
identity is stored or inferred. These controls bound local state and CPU churn;
because B2 advertisements are unauthenticated, they do not claim to prevent RF
interference or all local saturation attacks.

## Scan policy decision

The pure scheduler freezes two non-continuous modes:

| Mode | Window | Period | Duty cycle |
| --- | ---: | ---: | ---: |
| stable | 3000 ms | 30000 ms | 10% |
| failover | 8000 ms | 10000 ms | 80% |

A window equal to or longer than its period is rejected. Entering failover
opens a new aggressive window immediately. `evaluate()` exposes the desired
scanner state, start/stop/restart command, window boundaries and time until the
next scan. A compound restart recovers if a delayed callback crosses an
unobserved stop boundary, preventing accidental continuous scan. Platform
adapters must execute it as stop followed by start.

## Validation evidence

Commands:

```text
node --test shared/discovery/peer-directory-v1.test.mjs
node --test shared/discovery/scan-window-policy-v1.test.mjs
node scripts/simulate-discovery-soft-state.mjs --root .
node scripts/validate-contracts.mjs --root .
node scripts/validate-roadmap-package.mjs --root .
```

Results:

- peer-directory tests: 22 passed, 0 failed;
- scan-window policy tests: 11 passed, 0 failed;
- protocol/config contract validation: 14 JSON contracts, PASS;
- deterministic failover simulation: 100 cycles, 100 accepted observations,
  1 insert, 99 newer replacements, 0 rejects;
- soft-state boundary checks: `4999=fresh`, `5000=aging`,
  `15000=aging`, `15001=expired`;
- capacity test: 1024 accepted streams, next equal-strength fresh stream
  rejected and counted;
- pressure tests: exact `+6 dB`/`+5 dB` replacement boundary, aging
  replacement, a 1000-alias rejected flood, attempt-window throttle,
  cadence-limited/LRU pruning and delayed-window restart all PASS.

The 100 deterministic cycles cover the complete 10-second failover phase in
100 ms increments. With an 80% scan duty cycle, uniform arrival phase has a
theoretical scan-availability p95 of:

```text
(0.95 - 0.80) * 10000 ms = 1500 ms
```

The local simulation measured the same `1500 ms` p95. The theoretical maximum
wait for the next failover scan window is `2000 ms`. These are scheduler-only
figures and do not include radio loss, OS callback latency or device background
restrictions.

## Metrics

The directory exposes totals for observations, accepted/rejected outcomes,
inserts, duplicate refreshes, newer replacements, invalid payloads, RSSI
filtering, conflicts, older/ambiguous replay rejection, capacity rejection,
new-stream attempt throttling, controlled eviction, prune passes, expired
removals and clock regressions. Capacity gauges include current, limit,
utilization, high-watermark and current attempt-window usage.

The scan policy exposes evaluations by mode and state, start/stop/restart
commands, missed-boundary recoveries, observed transitions, mode changes, clock
regressions and the non-continuous-window invariant.

## Remaining gate

The roadmap gate requires reciprocal discovery p95 within 8 seconds on the
certified physical devices. That gate remains `PENDING`; the offline
`1500 ms` result must not be reported as physical BLE evidence. Android,
BlueZ/Raspberry runtime integration and cross-device capture are outside this
shared-core increment.

## Rollback

Bluetooth discovery remains disabled by default. Removing the additive
`shared/discovery` modules, simulator, report and B2 config assertions restores
the previous roadmap package without changing any running service or database.
