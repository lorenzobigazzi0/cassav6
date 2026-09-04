# V5BT B2 Radio Hysteresis - 2026-08-04

## Scope

This report records the two-handheld B2 diagnostic performed while the
certified Postazione tablet was unavailable. The evidence is physical but is
explicitly `NON_GATE_EVIDENCE`: it does not replace the formal
Palmare/Postazione pair, does not close B2 and does not authorize B3, B5 or
B6.

No business API, operational server or database contract changed. The change
is confined to the Android Lab Bluetooth coordinator, its policy and tests.

## Certified Lab Builds

| Role | Version | Code | Artifact | SHA-256 |
| --- | --- | ---: | --- | --- |
| Palmare | `1.0.36` | 37 | `artifacts/Palmare-Advanced-v1.0.36-V5BT-B5.7-Lab-B2-hysteresis-20260804-debug.apk` | `ccfd96034ad798649e95e41ac5404aab6be7f804bba095003be59bb6f4c95587` |
| Postazione | `2.0.22` | 24 | `artifacts/Postazione-Advanced-v2.0.22-V5BT-B5.7-Lab-B2-hysteresis-20260804-debug.apk` | `60cee3c61f8aeb1a3c7fa2302f78202b59d58ba20f9b4504f52922b02402214f` |

Both artifacts have a valid APK v2 signature. Package, version, code,
artifact path and digest are sourced from the shared certification matrix.

## Radio Policy

The Lab coordinator starts FAILOVER scan and advertising in `LOW_LATENCY`.
The first accepted peer observation arms a single 8,000 ms advertising
deadline while scan can transition immediately to STABLE. The deadline has
the following fail-closed rules:

- duplicate observations and advertisement updates do not extend it;
- expiry performs one downgrade to BALANCED advertising;
- entering FAILOVER cancels the old deadline and restores LOW_LATENCY;
- stop, logout and generation changes invalidate the pending callback;
- a stale callback cannot restart advertising;
- scheduling cancelled by a concurrent close is `ABORTED`, while a real
  scheduling failure is `FAILED` and enters the existing radio failure path.

This avoids repeatedly extending a high-power advertising window and closes
the stop/scheduling race without converting a close into a false radio error.

## Offline Verification

| Check | Result |
| --- | ---: |
| Palmare Android unit tests | `197/197 PASS` |
| Postazione Android unit tests | `190/190 PASS` |
| Advanced build consistency | `9/9 PASS` |
| Certification matrix plus B3 gate tests | `32/32 PASS` |
| B2 tests | `34/34 PASS` |
| B2 self-test controls | `128/128 PASS` |
| B0 independent-capability tests | `21/21 PASS` |

Both Android Lab variants were assembled and linted before the physical run.

## Read-Only Inventory

The retry inventory confirms Android targets, Raspberry, BlueZ, NTP,
services, registry and both existing enrollments. The enrolled identities
remain `READY`. Only the UPS data probe is unavailable; no protocol or driver
is inferred in its absence.

## B2 Schema 5 Evidence

The immutable redacted evidence is
`reports/physical/v5bt-b2-two-handheld-non-gate-hysteresis-20260804.json`.
Schema 5 attributes each timeout to the anonymous diagnostic role without
exporting either ADB serial.

| Metric | Result |
| --- | ---: |
| Requested/executed cycles | `100/100` |
| Passed cycles | 95 |
| Timeout cycles | 5 |
| Anonymous peer presence p95 | 19,145 ms |
| p95 after both reporters were ready | 14,271 ms |
| All-cycle lower-bound p95 | 24,418 ms |
| Passing cycles at or below 8 s | 51 |
| Passing cycles over 8 s through 12 s | 1 |
| Passing cycles over 12 s through 20 s | 39 |
| Passing cycles over 20 s | 4 |
| Timeout attribution | 3 `handheld_a`, 2 `handheld_b` |
| Scan/advertising/ingress/payload errors | 0 |

The required p95 is at most 8,000 ms, so the local measurement remains
`PENDING` and the runner cannot emit a physical certification PASS.

## Comparison

| Variant | Overall p95 | After-ready p95 | Result |
| --- | ---: | ---: | --- |
| Startup/ingress fix | 19,921 ms | 15,616 ms | threshold failed |
| Immediate advertising downgrade | 24,263 ms | 19,881 ms | regression |
| 8-second advertising hysteresis | 19,145 ms | 14,271 ms | improved, threshold failed |

The hysteresis removes the immediate-downgrade regression and slightly
improves the startup/ingress baseline, but it does not solve the long-tail
latency. The formal next B2 attempt still requires the certified Postazione
tablet and further radio characterization rather than promotion of this
diagnostic.

## B0 And Raspberry Continuity

The immutable redacted B0 evidence is
`reports/physical/v5bt-b0-two-handheld-independent-controls-20260804-retry1.json`.
For both handhelds it records PASS for scan, advertising, concurrent
scan/advertise, Wi-Fi/BLE coexistence and foreground/background operation.
GATT client and server are explicit FAIL (`NOT_PROVEN`): there was no client
activity and no stable runtime server owner. All ten continuity controls pass,
including stable process/reporters/session, no crash or ANR and bounded
polling. The runner therefore refuses to infer either missing GATT capability.

The redacted Raspberry attestation is
`reports/physical/v5bt-raspberry-continuity-b2-hysteresis-20260804.json`.
It covers 11,091,818 ms and 5,541 samples at a 2,000 ms poll interval, with a
maximum observed gap of 3,490 ms. Fixed boot, monotonic clock, both service
continuity checks, zero restarts and complete polling coverage all pass. The
attestation exports no hostname, network, boot, process or path identifier.

Current gate state:

- B0: `SUPPLEMENTAL_FAIL`, formal gate `PENDING`;
- B1: two existing Palmare enrollments `READY`;
- B2: `NON_GATE_EVIDENCE`, formal gate `PENDING`;
- B3: not started without the certified Postazione tablet;
- B5 and B6: `PENDING`.

The official roadmap progress remains **49%**.
