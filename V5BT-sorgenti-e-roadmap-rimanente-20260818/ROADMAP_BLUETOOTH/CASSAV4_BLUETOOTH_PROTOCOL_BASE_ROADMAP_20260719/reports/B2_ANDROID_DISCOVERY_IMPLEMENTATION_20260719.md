# V5BT B2 Android Discovery Implementation Report

## Scope

- Phase: B2 - automatic BLE discovery
- Evidence date: 2026-07-19
- Targets: Palmare Advanced and Postazione Advanced
- Decision: LOCAL IMPLEMENTATION PASS; PHYSICAL B2 GATE PENDING

This increment adds the Android scan/advertise runtime to both Advanced apps.
It does not enable Bluetooth in the standard builds, install an APK on a
device, modify V4, change the server or database, or implement a B3 GATT
session.

The copied product and local identity storage, self-test and binding namespaces
are named V5BT. The frozen wire UUID and rotating-alias derivation context
`CASSAV4-BT-ALIAS-V1` remain unchanged for protocol compatibility. The
standard runtime flags remain disabled, so no legacy identity migration is
performed.

## Fail-closed runtime gate

`AlwaysOnService` constructs the discovery coordinator only when
`BLUETOOTH_DISCOVERY_ENABLED` is true. Radio activation then requires all of
the following:

- `BLUETOOTH_IDENTITY_ENABLED=true`;
- Android API 33 or newer, checked before identity provisioning and the
  capability probe;
- native identity state exactly `READY`;
- configured node kind valid for the app;
- BLE feature and adapter present, with the adapter enabled;
- scan, advertise and connect permissions granted;
- capability probe classification exactly `FULL_NODE`.

Any failed prerequisite stops scanner and advertiser, clears anonymous peer
state, cancels scheduled work and removes `connectedDevice` eligibility. There
is no fallback identity, no WebView bridge and no alias, NodeId or packet
logging.

The foreground service starts first with its existing types. The
`connectedDevice` type is added dynamically only after the complete
prerequisite gate passes, and is removed when the radio stops. Permission and
adapter changes trigger an idempotent refresh. Closing the service stops both
radio adapters and the worker thread.

The Bluetooth adapter-state receiver is registered through `ContextCompat`
with `RECEIVER_EXPORTED`, as required for the protected system broadcast on
recent Android releases, and is always unregistered when the coordinator
closes.

All standard BuildConfig flags remain false:

| App | Diagnostics | Identity | Discovery | Enrollment | Lab | Node kind |
| --- | --- | --- | --- | --- | --- | --- |
| Palmare Advanced | false | false | false | false | false | handheld |
| Postazione Advanced | false | false | false | false | false | station |

With these standard values the coordinator is not constructed and no B2 radio
operation starts.

## Lab diagnostics and physical harness

When both the Lab and diagnostics build gates are enabled, each app writes a
bounded aggregate status to the app-private
`no_backup/bluetooth-discovery-status-v1.json`. The reporter publishes only:

- readiness and whether the radio is active;
- current `FAILOVER` or `STABLE` scan profile;
- active anonymous peer count;
- monotonic sample sequence and aggregate radio/directory counters.

It never publishes alias, NodeId, certificate, token, key, MAC address or
stable peer identity. The reporter runs every two seconds and writes through
`AtomicFile`. The ADB harness rejects unknown fields and uses sequence changes
to prove that samples are advancing.

Two complementary runners are included:

- `scripts/run-b2-android-adb-harness.mjs` performs strict single-device
  preflight, secure QR staging, redacted enrollment polling and discovery
  capture;
- `scripts/run-b2-android-gate.mjs` measures two already-enrolled devices over
  100 reciprocal cycles and requires p95 at or below 8000 ms.

The single-device harness treats enrollment `STORAGE_FAILED` as terminal. The
application emits that state before network access when its private QR input
cannot be securely removed or replaced.

## Advertisement and scan

- Frozen 128-bit service UUID:
  `b1c4a500-7d1f-4f32-9a64-4f4b6c410001`.
- Service Data payload is encoded and decoded as exactly 10 bytes.
- Reserved header and capability bits, protocol version, node kind, alias,
  nonzero boot id and sequence arithmetic are validated.
- Advertising includes one Service Data structure, no local name, no transmit
  power, no separate UUID list and no scan response.
- B2 advertising is non-connectable because B3 has not installed a GATT
  server. The adapter tracks this setting so a future B3 change forces a real
  restart even if the payload is unchanged.
- Capability bitmap advertises only the B2 FULL_NODE primitives; it does not
  claim concurrency, durability or backend routing.
- `serverReachable` is always false until B9.
- Boot id is random and nonzero. A new boot id is required before sequence
  wrap, preventing ambiguous reuse.
- Advertisement updates are limited to at most one per second and rotating
  aliases change on the 60-second epoch boundary.
- Stable scan is 3000 ms every 30000 ms; failover scan is 8000 ms every
  10000 ms. A window must be strictly shorter than its period.
- Window boundaries are anchored to `SystemClock.elapsedRealtime()`, not to
  chained relative callbacks. A delayed callback that crosses an unobserved
  idle interval produces a real scanner stop/start recovery.
- The runtime starts in failover mode, moves to stable mode while at least one
  unexpired anonymous peer is present, and returns to failover after the last
  peer expires. Profile changes are anchored at the change time and restart an
  active scan window.
- A dedicated expiry wakeup is scheduled at the first strict peer-expiry
  boundary. It forces a physical directory prune before profile evaluation, so
  expiry and the stable-to-failover transition do not depend on a future scan
  result.
- Scan uses a masked protocol-version Service Data filter and reads only
  `ScanRecord.getServiceData`.
- Scanner and advertiser callbacks are ownership- and generation-gated, so a
  late result, success or failure cannot affect a newer radio cycle.
- Scan ingress is a single-drain, latest-data-wins queue capped at 256 pending
  observations and processed in batches of 32. Overflow and invalidation are
  exposed only as aggregate counters. Cancelling a pending drain releases its
  scheduling token so the next accepted result can schedule a fresh drain.

The Android advertising API construction matches the frozen logical layout.
Raw primary AdvData length, Flags placement and controller emission still
require physical packet capture; they are not claimed as proven by this local
build.

## Anonymous peer state

Runtime peer state is keyed only by `(rotatingAlias, bootId)`. It never stores
or infers a NodeId, certificate, authorization result or MAC address.

The Android directory enforces the frozen B2 controls:

| Control | Value |
| --- | ---: |
| RSSI floor | -88 dBm, inclusive |
| Fresh | age below 5000 ms |
| Aging | age 5000 through 15000 ms |
| Expired | age above 15000 ms |
| Maximum streams | 1024 |
| Automatic full-prune cadence | at most once per 1000 ms |
| New stream attempts | at most 2048 per 10000 ms |
| Pressure replacement | aging peer or incoming RSSI at least 6 dB stronger |

Identical duplicates refresh RSSI and `lastSeen`. Same-sequence semantic
conflicts, older packets and half-range ambiguous packets are rejected without
refresh. Newer sequence values replace semantics. Expired state is removed
before stale sequence comparison, and clock regressions are rejected.

Metrics contain aggregate counters only. `firstObservationOffsetP95Ms` is the
offset from the start of a local scan window to a newly observed anonymous
stream. It is deliberately not named or reported as reciprocal discovery
latency and is not evidence for the physical B2 p95 gate.

## Build and test evidence

Both applications passed:

```text
./gradlew testDebugUnitTest assembleDebug --console=plain
./gradlew lintDebug --console=plain
```

| Application | XML suites | All tests | Bluetooth tests | Fail/error/skip |
| --- | ---: | ---: | ---: | ---: |
| Palmare Advanced | 21 | 109 | 95 | 0 / 0 / 0 |
| Postazione Advanced | 19 | 103 | 95 | 0 / 0 / 0 |

The Bluetooth suites cover B1 identity/enrollment and B2 payload, scheduler,
callback ownership, bounded ingress, prerequisite, peer-directory and
aggregate-metric boundaries. The XML evidence contains no failure, error or
skipped test.

The two Bluetooth Kotlin trees contain 38 files per application: 21 production
and 17 test files. All 38 Palmare/Postazione counterparts and the two TLS test
resources are byte-identical.
`AlwaysOnService`, `MainActivity`, `AndroidManifest.xml` and
`app/build.gradle.kts` remain the role-specific integration surfaces.

Final scheduler and queue tests cover missed absolute boundaries, monotonic
clock rejection, profile-change restart, a 300-result overflow and drain
cancellation recovery. Policy and runtime inspection additionally confirm the
strict 15001 ms expiry wakeup, automatic failover/stable profile selection,
the API 33 gate before identity and capability work, and explicit
`ContextCompat` receiver export/unregister handling.

Additional evidence:

- complete roadmap Node unit suite: 102 passed, 0 failed;
- all 38 Bluetooth production/test Kotlin files per app are byte-identical;
- merged manifests contain the three Android 12 Bluetooth permissions,
  `FOREGROUND_SERVICE_CONNECTED_DEVICE` and the declared service type;
- `dexdump` inspection of the packaged `BuildConfig` DEX fields confirms
  diagnostics, identity, discovery, enrollment and Lab are all false in both
  standard APKs; endpoint ID, URL and SPKI pin are empty;
- `aapt` confirms labels `Palmare Advanced` and `Postazione Advanced`, and
  `apksigner` verifies APK Signature Scheme v2 for both certified standard
  APKs;
- static audit found no B2 logs, console output, WebView bridge calls or old
  discovery-latency metric name;
- generated app identities are
  `com.sentrapa.palmare.advanced` version code 22 / `1.0.21` and
  `com.sentrapa.postazione.advanced` version code 18 / `2.0.16`;
- app labels remain `Palmare Advanced` and `Postazione Advanced`.

The two certified standard APKs keep all five Bluetooth runtime/build flags
false and have a valid APK Signature Scheme v2 signature.

| Certified artifact | Flags | Size (bytes) | SHA-256 |
| --- | --- | ---: | --- |
| `Palmare-Advanced-v1.0.21-debug.apk` | standard, all false | 16396585 | `6b74b7571efdca47ca472a3994dea802e2f5e1f7a3f1abeb3596b36dfbb811ab` |
| `Postazione-Advanced-v2.0.16-debug.apk` | standard, all false | 14927491 | `7d181cd4d913356f22529c208ee37dc0965954830251629546fa1c0543853a38` |

Earlier B0 APKs remain in the artifact inventory for traceability. The B2 Lab
variants listed below are historical pre-enrollment builds. Their packaged
`BuildConfig` fields set diagnostics, identity and discovery true, but they do
not contain a configured TLS enrollment endpoint/pin and cannot perform a
fresh physical enrollment.

| Current B2 Lab artifact | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `Palmare-Advanced-v1.0.20-B2-Lab-debug.apk` | 16502593 | `edff210e786f701ba52477f83381d1ba37f82127967be73bafe2247608699b94` |
| `Postazione-Advanced-v2.0.15-B2-Lab-debug.apk` | 15028701 | `4d74c2d42af24d65e30bede10e9cc755928051e72e2f0cf4a3d8b53a1df82b0f` |

A historical Lab variant replaces the corresponding standard Advanced app
during installation because it uses the same Advanced application ID. It does
not replace V4. The enrollment-ready Lab APKs produced on 2026-07-20 and their
TLS evidence are certified separately in
`reports/V5BT_ANDROID_ENROLLMENT_DISCOVERY_BUILD_20260720.md`; they remain
uninstalled.

Both current standard artifacts are signed with the Android Debug certificate
using APK Signature Scheme v2. Production release signing remains pending and
is not claimed by this local gate.

## Remaining physical gate

The B2 gate remains `PENDING`. It requires:

- an attached and authorized Android device pair; the final
  `adb devices -l` check returned no devices;
- authenticated native enrollment so each physical app reaches identity
  `READY` without a WebView transport;
- reciprocal discovery measurements on the certified device pair, with p95
  at or below 8 seconds;
- raw controller capture proving the complete primary AdvData layout and
  31-byte budget on each target Android model;
- Android background/OEM lifecycle tests and permission revocation recovery;
- the still-pending B0 physical scan/advertise concurrency matrix.

The local harness evidence added on 2026-07-20 is:

- ADB harness unit suite: 16 passed, 0 failed;
- ADB harness built-in self-test: 7 checks, PASS;
- reciprocal gate built-in self-test: 48 checks, PASS;
- physical ADB inventory: no connected devices;
- Lab Raspberry reachability: `192.168.1.79` returned `No route to host`.

The reciprocal runner requires exactly 100 cycles, the certified
package/model/version pair, fresh increasing samples from the same reporter,
nonzero scan and advertising activity, anonymous peer presence and zero
critical failures or drops. Its `localMeasurementVerdict` may pass, while the
physical `gate` remains `PENDING` until distinct RF/controller captures are
reviewed independently. No local first-observation offset or offline scheduler
result substitutes for those measurements.

## Rollback

Keep `cassaBluetoothDiscovery` false, which is already the standard default.
This leaves the coordinator unconstructed and the radio inactive. Removing
the additive B2 Android classes and rebuilding returns to B1 without any
server, database, Raspberry or V4 rollback.
