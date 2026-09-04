# V5BT Android Enrollment And Discovery Local Build Report

## Scope

- Evidence date: 2026-07-20
- Targets: Palmare Advanced and Postazione Advanced
- Scope: standard and enrollment-ready Lab APKs, native TLS enrollment and
  local B1/B2 test tooling
- Decision: LOCAL BUILD AND TLS TESTS PASS; PHYSICAL B1/B2 GATES PENDING

This report certifies the local V5BT build artifacts and fail-closed test
evidence. It does not certify Android Keystore behavior on a physical device,
deploy the enrollment endpoint, measure BLE discovery or modify the active V4
installation.

## Application builds

| Application | Application ID | Version | JVM tests |
| --- | --- | --- | ---: |
| Palmare Advanced | `com.sentrapa.palmare.advanced` | `1.0.21` (`22`) | 109 / 109 |
| Postazione Advanced | `com.sentrapa.postazione.advanced` | `2.0.16` (`18`) | 103 / 103 |

The Advanced application IDs remain distinct from the V4 applications. A Lab
APK uses the same Advanced ID as its corresponding standard APK, so it replaces
only that Advanced variant during installation.

## Certified artifacts

| Artifact | Variant | Size (bytes) | SHA-256 |
| --- | --- | ---: | --- |
| `Palmare-Advanced-v1.0.21-debug.apk` | standard | 16396585 | `6b74b7571efdca47ca472a3994dea802e2f5e1f7a3f1abeb3596b36dfbb811ab` |
| `Palmare-Advanced-v1.0.21-V5BT-Bluetooth-Lab-debug.apk` | Lab | 16397317 | `c352b944180b3e39f12f27b051170ceeb66610dfd00f953b0a735ebc9a5fbd55` |
| `Postazione-Advanced-v2.0.16-debug.apk` | standard | 14927491 | `7d181cd4d913356f22529c208ee37dc0965954830251629546fa1c0543853a38` |
| `Postazione-Advanced-v2.0.16-V5BT-Bluetooth-Lab-debug.apk` | Lab | 14796811 | `b01c56a28159bdeae2651c2ed2872dcd7f0b079e5720c0f1b087b9b324cb4061` |

Independent `sha256sum` verification matched
`artifacts/V5BT_ADVANCED_APK_SHA256SUMS`. `apksigner verify --verbose`
reported APK Signature Scheme v2 `true` for all four artifacts. These are
debug-signed artifacts; production release signing is not claimed.

## Packaged configuration

DEX inspection of both standard APKs confirms:

- diagnostics, identity, discovery, enrollment and Lab flags are all `false`;
- enrollment endpoint ID, URL and SPKI pin are empty strings;
- no Bluetooth enrollment or discovery runtime can start from these defaults.

DEX inspection of both Lab APKs confirms all five flags are `true` and freezes:

```text
endpointId = raspberry-lab-v5bt
url        = https://192.168.1.79:9443/v1/enroll
spkiPin    = sha256/CFZJC8GYrp/RLpHcftpZR0S3TpQr5SxFJ20tI90r6KY=
```

Normal HTTPS hostname/SAN validation remains active in addition to the leaf
SPKI pin. The Lab build does not trust arbitrary certificates.

## Native TLS tests

Each application passed the same four-test TLS integration suite. The suite
covers five connection outcomes:

1. matching SPKI pin and IP SAN succeeds over TLS 1.3;
2. a wrong SPKI pin fails closed;
3. a wrong SAN fails closed even when the SPKI pin matches;
4. an expired pinned certificate fails closed;
5. a TLS 1.2-only server cannot downgrade the TLS 1.3-only client.

The positive case returns a validated enrollment response. Every negative case
terminates as TLS authentication failure before identity import.

## Local Lab certificate

The local Lab certificate was generated for the planned isolated endpoint:

```text
subjectAltName = IP:192.168.1.79
notBefore      = 2026-07-19 23:53:42 UTC
notAfter       = 2027-07-19 23:53:42 UTC
SPKI pin       = sha256/CFZJC8GYrp/RLpHcftpZR0S3TpQr5SxFJ20tI90r6KY=
```

Its Lab-only private key has mode `0600`. The private key is not embedded in
either APK, copied into this roadmap package or reproduced in any report. The
certificate and pin remain local preparation only: they were not installed on
the Raspberry.

## Local validation totals

- Complete roadmap Node unit suite: 102 passed of 102.
- Palmare Advanced JVM tests: 109 passed of 109.
- Postazione Advanced JVM tests: 103 passed of 103.
- Node enrollment transport, registry and server rerun: 36 passed of 36
  (`12 + 20 + 4`).
- Extended B1/B2 Android/ADB harness: 16 passed of 16.
- Strict post-enrollment discovery gate self-test: 48 passed of 48.
- Android `lintDebug`: PASS for both applications.
- APK Signature Scheme v2: PASS for all four APKs.
- Roadmap package validation and exact manifest inventory: PASS.

The Node total supersedes the earlier 35-test snapshot after the additional
cross-language and isolation regression coverage was included.

## Physical gate status

`adb devices -l` returned no attached devices. Therefore no certified Android
device performed Keystore generation, enrollment, identity recovery,
advertising, scanning or reciprocal discovery.

A read-only SSH reachability attempt to `192.168.1.79` failed with
`No route to host`. No remote command ran, and no file write, service restart,
certificate installation or database operation occurred. The HTTPS enrollment
endpoint was not started or exercised on the target Raspberry.

Consequently:

- B1 physical enrollment remains `PENDING`;
- B2 reciprocal discovery and p95 measurement remain `PENDING`;
- Android controller packet capture, lifecycle/permission recovery and the
  physical capability matrix remain `PENDING`.

Local TLS integration, unit tests, dry runs or packaged Lab configuration do
not substitute for those physical measurements.

## V4 isolation

The standard Advanced APKs remain Bluetooth-off. All Lab endpoint material is
V5BT-specific, and no action in this evidence wrote to or restarted the active
V4 server, database, service or applications. No V4 rollback is required.
