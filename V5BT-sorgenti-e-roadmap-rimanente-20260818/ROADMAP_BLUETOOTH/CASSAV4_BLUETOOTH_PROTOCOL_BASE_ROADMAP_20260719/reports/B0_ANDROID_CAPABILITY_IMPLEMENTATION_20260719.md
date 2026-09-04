# B0 Android Capability Implementation Report

## Scope

- Phase: B0 - hardware capability gate
- Evidence date: 2026-07-19
- Apps: Palmare Advanced and Postazione Advanced
- Decision: IMPLEMENTATION PASS; DEVICE GATE PENDING

## Implementation

Both Android apps contain the same native capability probe and classification
policy. The probe reports BLE feature and adapter presence, permissions,
scanner/advertiser availability, multiple advertising support, offloaded scan
features, GATT server opening and the resulting node classification.

Runtime permissions and the `CassaBluetoothDiagnostics` WebView bridge are
available only when the Gradle property below is enabled:

```text
-PcassaBluetoothDiagnostics=true
```

The generated default BuildConfig value is `false`, so normal Advanced APKs do
not request Bluetooth runtime permissions or expose the diagnostics bridge.
The report never marks the complete B0 gate as passed: concurrent
scan/advertise, Wi-Fi/BLE coexistence and background/foreground behavior remain
field tests.

## Verification

The following counts are the historical B0/B1 increment snapshot. Current B2
build and test evidence is recorded separately in
`reports/B2_ANDROID_DISCOVERY_IMPLEMENTATION_20260719.md`.

| App | Package | Unit tests | Bluetooth tests | Result |
| --- | --- | ---: | ---: | --- |
| Palmare Advanced | `com.sentrapa.palmare.advanced` | 37 | 7 | PASS |
| Postazione Advanced | `com.sentrapa.postazione.advanced` | 31 | 7 | PASS |

The Bluetooth tests cover all 16 combinations of scan, advertise, GATT client
and GATT server capabilities, plus permission, disabled-adapter, unsupported
hardware and incomplete-probe states.

The complete unit-test totals also include the sixteen B1 identity and rotating
alias tests now shared by both Advanced applications. All test suites completed
with zero failures and zero errors.

## Device gate

No Android device was connected through ADB during this evidence collection.
The targets in `configs/device-capability-matrix.json` therefore remain:

- Samsung `SM-A165F`: `UNKNOWN`
- Samsung `SM-T503`: `UNKNOWN`

At least two real `FULL_NODE` classifications and all B0 field tests are still
required.

## Gate record

- Implementation decision: PASS
- Hardware decision: PENDING
- Runtime default: diagnostics OFF
- Rollback: omit the Gradle property or set it to `false`
