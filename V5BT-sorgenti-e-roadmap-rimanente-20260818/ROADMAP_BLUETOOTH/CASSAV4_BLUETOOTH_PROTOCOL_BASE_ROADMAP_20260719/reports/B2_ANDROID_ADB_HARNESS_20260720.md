# V5BT B2 Android/ADB Harness Report

## Scope

- Phase: B1 enrollment evidence and B2 automatic BLE discovery
- Evidence date: 2026-07-20
- Targets: Palmare Advanced and Postazione Advanced Lab builds
- Decision: LOCAL HARNESS PASS; PHYSICAL B1/B2 GATES PENDING

This increment supplies repeatable, redacted tooling for the physical gate. It
does not install an APK, grant permissions, deploy to Raspberry, enable a
listener, restart V4 or modify any database.

## Harness controls

`scripts/run-b2-android-adb-harness.mjs` requires an explicit ADB serial and
checks exact package, optional model, API 33 or newer, BLE support, adapter
state, launcher, debuggable `run-as` access, current Android user and all three
runtime Bluetooth permissions.

For initial enrollment, the QR source must be stdin or an owner-only regular
file with mode `0400`/`0600`. The harness opens files with `O_NOFOLLOW`, limits
input to 512 bytes and stages the QR only over stdin of:

```text
adb -s <serial> shell -T run-as <package> sh -c <fixed-script>
```

The token never enters an argument vector. The package-private input is
installed atomically with mode `0600`, and the in-process byte buffer is
overwritten after staging.

Enrollment and discovery files use strict allowlists. Extra fields, malformed
types or secret-shaped output fail the run. Reports exclude enrollment token,
aliasKey, keys, certificate material, NodeId and BLE address. The
single-device operator report retains the explicitly selected ADB serial for
physical correlation; the reciprocal gate report omits both serials.
`STORAGE_FAILED` is terminal and records that the app refused network access
because private QR cleanup failed.

`scripts/run-b2-android-gate.mjs` is the stricter post-enrollment gate. It
requires two distinct, already-enrolled Advanced devices and performs 100
reciprocal cycles. It binds the certified target model, package, version and
current Android user; requires fresh increasing samples from the same reporter,
nonzero scan/advertising activity, anonymous peer observations and zero
critical failures or drops. Reciprocal p95 must be at or below 8000 ms.

A successful local measurement sets `localMeasurementVerdict` to `PASS`.
The physical `gate` deliberately remains `PENDING` until nonempty, distinct RF
and controller captures have been reviewed independently.

## Local evidence

Executed with the pinned Node v22.23.1 runtime:

```text
node --test scripts/run-b2-android-adb-harness.test.mjs
node scripts/run-b2-android-adb-harness.mjs --self-test
node scripts/run-b2-android-gate.mjs --self-test
```

Results:

- ADB harness tests: 16 passed, 0 failed;
- ADB harness self-test: 7 checks, PASS, no ADB or physical access;
- reciprocal gate self-test: 48 checks, PASS, no ADB or physical access;
- QR duplicate-key, symlink/mode, stdin-only staging and report-secret
  firewall negative cases: PASS;
- redacted enrollment `STORAGE_FAILED` and aggregate discovery schemas: PASS.

These results prove the harness input, output and decision boundaries. They do
not prove Android Keystore, TLS, BLE radio or reciprocal physical discovery.

## Physical gate status

The physical run was not possible:

- `adb devices -l` returned no connected devices;
- the Lab Raspberry at `192.168.1.79` was unreachable, with `No route to host`;
- no real TLS certificate/SAN/SPKI pin was installed or exercised;
- no physical identity reached `READY`;
- no reciprocal cycles, p95 measurement or Android controller capture exists.

B1 physical and B2 physical therefore remain `PENDING`.

## Required next evidence

1. Restore read-only reachability to the isolated V5BT Raspberry environment.
2. Install a matching Lab certificate and configure its leaf SPKI pin only in
   the Lab APKs.
3. Attach and authorize the Samsung handheld and tablet targets.
4. Enroll both apps through the secure single-device harness.
5. Run the two-device 100-cycle gate and retain only its redacted report.
6. Capture distinct raw RF/controller evidence and run permission/lifecycle
   recovery tests.
7. Record an independent evidence review before changing the physical gate
   from `PENDING`.

## V4 isolation and rollback

The optional btmon helper is only a non-executing, credential-free plan. No SSH
command is run by the harness. All runtime flags remain disabled in standard
Advanced APKs, and no action in this evidence changed the active V4 server,
database, services or applications.

Rollback is to keep Lab/enrollment/discovery flags false and discard any
uninstalled Lab-only QR input. No V4 rollback is required.
