# B1 Android Identity And Enrollment Gate Report

## Scope

- Phase: B1 - protocol, identity and provisioning
- Evidence date: 2026-07-19
- Targets: Palmare Advanced and Postazione Advanced
- Decision: LOCAL IMPLEMENTATION PASS; PHYSICAL DEVICE GATE PENDING

This increment compiles the B1 identity primitives into both Advanced apps.
It does not enable Bluetooth identity at runtime, expose credentials to the
WebView, deploy to V4 or perform a real enrollment.

## Implemented controls

- Canonical lowercase NodeId generated and persisted by Android, then required
  and echoed unchanged by the registry.
- Ed25519 key generation in Android Keystore on API 33 or later through the
  Android 13/14 compatible EC generator and `ed25519` parameter.
- Non-exportable private key enforcement plus exact 44-byte SPKI DER structure,
  OID `1.3.101.112`, SHA-256 fingerprint and KeyInfo validation.
- Signing and alias-key Keystore security levels are included in native status
  reports without exposing secret key material.
- Android 13/14 signing operation test requires two deterministic 64-byte
  Ed25519 signatures to match. It deliberately does not call `initVerify`,
  because those AOSP releases do not provide the required software verifier.
- Exact nine-field enrollment response validation, including protocol version,
  NodeId, certificateId, public-key algorithm/SPKI, alias algorithm/encoding,
  canonical 32-byte alias key and UTC millisecond timestamp.
- Full response binding to the local NodeId, SPKI and fingerprint.
- Alias key imported as a non-exportable HmacSHA256 Android Keystore key.
- No caller-selectable reprovision mode and no overwrite path in B1.
- Crash-safe `PENDING`/`READY` state with a domain-separated HMAC commitment
  over NodeId and certificateId. Recovery promotes only a matching Keystore
  key, using a constant-time comparison.
- Signing and rotating aliases require a complete `READY` binding.
- The supplied alias bytes and working copies are cleared on return.
- The former `CassaBluetoothIdentity` WebView interface and its class were
  removed from both applications.
- Private Android identity namespaces now use `CASSAV5BT-BT-*` for domain
  separation, `cassav5bt.bluetooth.*` for Android Keystore aliases and
  `cassav5bt_bluetooth_identity_v1` for preferences. A regression test freezes
  all five concrete values in each app.

The native enrollment entry point accepts only an already strictly parsed
structured object. A future JSON parser must reject duplicate keys before
calling it.

## Build and test evidence

Both applications passed:

```text
./gradlew testDebugUnitTest assembleDebug --console=plain
```

| Application | All tests | B1 tests | Result |
| --- | ---: | ---: | --- |
| Palmare Advanced | 37 | 16 | PASS |
| Postazione Advanced | 31 | 16 | PASS |

The B1 matrix covers every enrollment response field, missing and extra
fields, wrong types, protocol mismatch, uppercase and mismatched UUIDs,
certificateId, Ed25519 SPKI length/OID/canonical base64/local binding,
fingerprint coherence, alias algorithm/encoding/key, UTC time, overwrite
policy and rotating-alias inputs.

Additional evidence:

- pure Kotlin compilation and 16 JUnit tests: PASS;
- Android API 34 targeted type-check: PASS;
- registry enrollment gate: 17 cases, PASS locale condizionato;
- semantic contract validation: 14 JSON contracts, PASS;
- roadmap package validation: PASS;
- independent static security review: two API 33/34 blockers found, fixed and
  followed by clean builds of both apps;
- APK Signature Scheme v2 verification: PASS;
- DEX inspection: both Bluetooth feature flags `false`, identity manager
  present, WebView identity bridge absent.

Historical standard APK evidence for the B1 increment, superseded by the B2
build evidence in `reports/B2_ANDROID_DISCOVERY_IMPLEMENTATION_20260719.md`:

```text
b2eed745bce7c03f0e42916e52a0f63c40a2484d4435adb6dce1efcc337c797d  Palmare-Advanced-v1.0.19-debug.apk
d8d90724418d76c2f6c3ec96dbc8dc009a4771a5b7d1c84040003f6fccaa97a1  Postazione-Advanced-v2.0.14-debug.apk
```

## Runtime state

`BLUETOOTH_IDENTITY_ENABLED=false` in both standard APKs. No native runtime
transport invokes the manager, and no JavaScript interface can provision,
reset, sign with or inspect the identity. V4 services, server and database were
not modified or restarted.

No migration from `CASSAV5-BT-*`, `cassav5.bluetooth.*` or
`cassav5_bluetooth_identity_v1` is implemented or required. Identity remained
disabled in the standard runtime, so those former private namespaces did not
create credentials or preferences that must be preserved.

## Remaining gate evidence

- Run AndroidKeyStore generation, metadata, signing and HMAC import on the
  certified physical Android 13/14 devices.
- Exercise power-loss recovery between `PENDING`, key import and `READY`.
- Implement an authenticated native TLS enrollment transport with a
  duplicate-key rejecting parser. It must never reuse the permissive WebView
  network stack.
- Capture accepted advertisements on each target controller model.

No physical Android Keystore test was run for this report.

## Rollback

Keep the identity flag false, remove the B1 identity source set and rebuild the
two Advanced apps. No server, database or V4 rollback is required.
