# V5BT B3 Android Connectivity Agent Report

## Scope

- Phase: B3 - Android connectivity agent and lifecycle
- Evidence date: 2026-07-20
- Targets: Palmare Advanced and Postazione Advanced
- Decision: LOCAL IMPLEMENTATION PASS; PHYSICAL 60-MINUTE GATE PENDING

This increment adds the native `BluetoothFailoverService`, deterministic
connectivity state and redacted diagnostics to both Advanced applications. It
does not install an APK, deploy to Raspberry, restart V4, change a server or
database, open GATT, create a direct session or transport application data.

## Fail-closed activation

The master Gradle property `cassaBluetoothFailover` defaults to `false`.
`BLUETOOTH_FAILOVER_ENABLED` can become true only when the build is also Lab
and both identity and discovery are enabled. Standard Advanced builds
therefore leave the service unstarted and publish no B3 radio activity.

The B3 session flags also default to false:

```text
cassaBluetoothDirectServer=false
cassaBluetoothPeerLink=false
```

They are reserved for B5/B6. If either is requested during B3, the native
policy blocks discovery and records a degraded fault instead of opening a
future resource. State-machine events for `DIRECT_SERVER` and
`PEER_CONNECTED` are independently guarded by default.

## Native service and lifecycle

`BluetoothFailoverService` owns:

- the permission snapshot for scan, advertise and connect;
- the B2 discovery coordinator;
- a synchronized, idempotent connectivity state machine;
- aggregate lifecycle metrics;
- a bounded state-listener store;
- separate Lab and WebView status surfaces.

The operational B3 states are `DISABLED`, `PERMISSION_REQUIRED`, `STARTING`,
`DISCOVERING`, `DEGRADED`, `BACKOFF` and `STOPPED`. The enum also reserves
`DIRECT_SERVER` and `PEER_CONNECTED`, but neither is operationally reachable
in B3.

Duplicate lifecycle events are idempotent. Illegal and future-guarded events
do not change state. Metrics are saturating aggregate counters only: starts,
stops, backoffs, transitions, duplicates and invalid/guarded events.

## Foreground-service ordering

The native service first enters foreground with `dataSync`. After the complete
identity, capability, adapter and permission gate reaches `READY`, the
discovery coordinator requests `connectedDevice`.

Scanner and advertiser start only after that FGS type update is accepted. If
it fails, radio resources are stopped and retry enters backoff. Permission
loss, adapter failure, non-ready identity or service destruction also stop
scanner/advertiser, clear anonymous peer state and remove
`connectedDevice` eligibility.

This ordering is structural in the coordinator:

```text
READY -> accept FGS connectedDevice -> start radio
```

## No GATT or sessions in B3

B3 reuses the non-connectable B2 scanner/advertiser and anonymous peer
directory. It does not install `GattServer`, `GattClient` or `SessionManager`.
The Lab contract must always report:

```text
gattServerActive=false
gattClientActive=false
sessionCount=0
```

No direct Android-to-Raspberry or Android-to-Android channel is claimed. Those
remain B5 and B6 work.

## Separate redacted status surfaces

The Lab-only reporter writes atomically to the package-private file:

```text
no_backup/bluetooth-connectivity-agent-status-v1.json
```

It is separate from `bluetooth-discovery-status-v1.json`. Its exact allowlist
contains schema/source and Lab gates, monotonic sample timestamps and
sequence, connectivity state, aggregate counters and resource booleans.
Serials, NodeId, rotating alias, BLE/MAC address, token, key, certificate and
enrollment material are forbidden.

The optional WebView diagnostic badge receives a narrower four-field snapshot:

```json
{
  "schemaVersion": 1,
  "source": "V5BT_ANDROID_CONNECTIVITY_AGENT",
  "sequence": 0,
  "state": "DISABLED"
}
```

The bridge exposes only `getState()` and native state-change events. It has no
write method and cannot start radio, change state, choose a peer, open a
session or send a command.

## Local evidence

Local tests pass for both Advanced application trees. They cover:

- the supported transition matrix, illegal events and future-state guards;
- duplicate-event idempotency and deterministic 60-minute/no-churn
  simulation;
- aggregate lifecycle counters;
- exact four-field WebView JSON redaction;
- bounded, thread-safe listeners and idempotent unsubscribe;
- exact Lab status redaction with dormant GATT/session resources;
- fail-closed feature policy and Android Nearby Devices permission set;
- Android application integration and compilation.

The deterministic 3600-tick test proves software idempotency only. It is not a
physical 3600-second foreground-service soak and cannot close the phase gate.

Final local verification:

- Palmare Advanced: 130 JVM tests passed, zero failures; `lintDebug` and both
  standard/Lab `assembleDebug` builds passed.
- Postazione Advanced: 124 JVM tests passed, zero failures; `lintDebug` and
  both standard/Lab `assembleDebug` builds passed.
- Production and test files in the two Bluetooth packages are byte-identical.
- Roadmap Node suite: 130 tests passed, zero failures.
- B3 runner: 28 tests passed, 39 self-test checks passed and dry-run confirmed
  the fixed 3600-second duration, 61 minimum FGS audits and `PENDING` gate.
- B2 reciprocal self-test: 48 checks passed; 15 contracts and 6 Raspberry
  Python advertisement tests passed.
- V5BT workspace isolation: 8 tests passed, zero failures.
- Independent integration review found no remaining blocking issue.

The final runner sends Android HOME before the timer, audits the current-user
foreground service initially, every 60 seconds and finally, requires
`dataSync` plus `connectedDevice` whenever radio resources are active, and
fails on new Java/native crashes or ANRs found through `ApplicationExitInfo`.

## Certified APK inventory

| Artifact | Package/version | Size (bytes) | SHA-256 |
| --- | --- | ---: | --- |
| `Palmare-Advanced-v1.0.22-debug.apk` | `com.sentrapa.palmare.advanced` / 23 / 1.0.22 | 16567508 | `ea5a8bcd852155d0cac75e80a7bae8e1b3e8e531b3f95ef9db91f3ebec569065` |
| `Palmare-Advanced-v1.0.22-V5BT-Bluetooth-B3-Lab-debug.apk` | `com.sentrapa.palmare.advanced` / 23 / 1.0.22 | 16568303 | `ce16f98d89a2da0dc44e0102cf83211694b2a422b8513b09ec628fde8b3446dc` |
| `Postazione-Advanced-v2.0.17-debug.apk` | `com.sentrapa.postazione.advanced` / 19 / 2.0.17 | 15093438 | `6ae7e6eda2a21f16680f867df30fbf3f50bc1f6bde49326e14abed34cd6cdf3d` |
| `Postazione-Advanced-v2.0.17-V5BT-Bluetooth-B3-Lab-debug.apk` | `com.sentrapa.postazione.advanced` / 19 / 2.0.17 | 15094285 | `67442280965b731fb3f0c5f5c31be07dcf1459849e1cb2fae733e65a9cc371a8` |

`aapt`, `apkanalyzer` and `apksigner` verified package/version, the declared
non-exported B3 service with foreground type mask `0x11`, and APK v2
signatures. Every Bluetooth and enrollment flag and endpoint field is off or
empty in the standard APKs. The Lab APKs have Lab, diagnostics, identity,
discovery, enrollment, failover and diagnostic badge enabled; Direct Server
and Peer Link are false. Folder and `artifacts/` copies are byte-identical.

## Physical gate status

The required physical observation is exactly 3600 seconds on the fixed
Palmare Advanced and Postazione Advanced Lab targets. It requires fresh,
monotonic samples from one reporter instance for the complete run, no
30-second silence, exactly one start, zero stops and invalid transitions, no
out-of-scope direct/peer state, no active GATT resource and zero sessions.

The physical run has not started:

- `adb devices -l` returned no connected devices;
- no Advanced Lab APK was installed or launched on either target;
- no 3600-second B3 status capture exists;
- the Lab Raspberry `192.168.1.79` remained unreachable with `No route to
  host`.

The B3 harness deliberately does not contact Raspberry, so Raspberry
unreachability is recorded as the wider Lab condition, not as a substitute
for or direct blocker of the Android service measurement. Absence of the two
ADB targets is the immediate blocker. The physical B3 gate remains `PENDING`.

## V4 isolation

All work is confined to the V5BT copy and local roadmap evidence. No V4 APK
was replaced, no active V4 process or service was restarted, no endpoint was
exposed and no V4 server or database was modified. V4 remains intact.

## Required next evidence

1. Attach and authorize the two fixed Android targets.
2. Reverify the certified APK hashes before installation.
3. Install only those V5BT Advanced Lab packages and confirm the private reporter
   contract is fresh and redacted.
4. Run `scripts/run-b3-android-service-gate.mjs` for its fixed 3600 seconds.
5. Review the redacted physical report separately before changing the gate
   from `PENDING`.

## Rollback

Keep `cassaBluetoothFailover=false`, its standard default. The service remains
unstarted and no B3 radio operation occurs. If a Lab APK has been installed,
replace it with the same-version standard Advanced APK signed by the same
certificate; all Bluetooth/enrollment flags then return to false. No V4
rollback is required.
