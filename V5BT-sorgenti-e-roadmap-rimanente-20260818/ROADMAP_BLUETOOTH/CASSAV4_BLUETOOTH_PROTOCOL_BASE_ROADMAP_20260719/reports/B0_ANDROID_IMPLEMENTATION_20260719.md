# B0 Android Implementation Report

## Report scope

- Phase: B0 - Hardware capability gate
- Evidence date: 2026-07-19
- Targets: Palmare Advanced and Postazione Advanced
- Decision: PENDING

The diagnostic capability probe is implemented and build-verified in both
Advanced applications. No Android device was attached through ADB during this
activity, so this report does not certify any phone or tablet.

## Implemented behavior

- Android 12+ scan, advertise and connect permissions are declared.
- Legacy Bluetooth permissions are limited to Android 11 and earlier.
- BLE hardware is optional, so unsupported devices can still install the app.
- The probe records adapter, permission, scanner, advertiser, offload and GATT
  server observations.
- Incomplete observations remain unclassified instead of being reported as a
  false `CLIENT_ONLY` or `UNSUPPORTED` result.
- The JSON report preserves unknown values as explicit JSON `null`.
- Field tests still pending are included in the diagnostic output.

## Feature gate

`BLUETOOTH_DIAGNOSTICS_ENABLED` defaults to `false`.

With the default build:

- no Bluetooth runtime permissions are requested by this feature;
- the JavaScript diagnostic bridge is not registered;
- no Bluetooth discovery, advertising or business traffic is started.

The B0 laboratory build is generated with:

```text
-PcassaBluetoothDiagnostics=true
```

All later roadmap flags remain disabled.

## Application identity

| Application | Package ID | Label |
| --- | --- | --- |
| Palmare Advanced | `com.sentrapa.palmare.advanced` | `Palmare Advanced` |
| Postazione Advanced | `com.sentrapa.postazione.advanced` | `Postazione Advanced` |

These IDs are separate from the V4 applications and allow side-by-side
installation.

## Build evidence

This table is the historical B0/B1 increment snapshot. It is not the current
B2 build total; current Android build evidence is recorded in
`reports/B2_ANDROID_DISCOVERY_IMPLEMENTATION_20260719.md`.

| Application | Unit tests | Result |
| --- | ---: | --- |
| Palmare Advanced | 37 | PASS |
| Postazione Advanced | 31 | PASS |

Both standard and B0 diagnostic APKs:

- compile against Android API 34;
- target Android API 34;
- require Android API 24 or later;
- pass APK Signature Scheme v2 verification.

The totals include seven B0 classifier/capability tests and sixteen B1
identity/rotating-alias tests in each application. All suites completed with
zero failures and zero errors.

Artifact hashes are maintained in `artifacts/SHA256SUMS` at the V5 workspace
root.

## Open field evidence

1. Connect the target Android devices through ADB.
2. Install the B0 diagnostic APK corresponding to each app.
3. Grant Nearby Devices permissions.
4. Capture the diagnostic JSON for each model and Android version.
5. Run active scan, advertising, GATT client and GATT server tests.
6. Run scan plus advertise concurrently.
7. Run Wi-Fi plus BLE coexistence under application load.
8. Run foreground, background and OEM battery-management tests.
9. Certify at least two real `FULL_NODE` devices.

## Phase gate record

- Phase: B0
- Decision: PENDING
- Tests: Android builds and unit tests pass; real device radio tests not run.
- Findings: Diagnostic implementation is ready; no device classification is
  accepted without field evidence.
- Rollback: Keep the default feature flag false or remove the diagnostic build.
  No production V4 application or Raspberry service was modified.
