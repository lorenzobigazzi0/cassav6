# V5BT B1 Native Enrollment Transport Progress Report

## Scope

- Phase: B1 - protocol, identity and provisioning
- Evidence date: 2026-07-20
- Scope: native Android enrollment flow, shared server transport and separate
  Raspberry HTTPS endpoint
- Decision: LOCAL ENROLLMENT TRANSPORT PASS; PHYSICAL B1 AND B2 GATES PENDING

This increment closes the missing local transport path between the copied
Advanced apps and the V5BT device registry. It does not deploy to Raspberry,
install a Lab certificate, bind a listener to the LAN, enroll a physical
device, enable Bluetooth in a standard APK or modify the active V4 system.

## Frozen request contract

`contracts/enrollment-request-v1.schema.json` defines exactly eight fields:
protocol version, endpoint identifier, one-time token, NodeId, Ed25519 public
key algorithm/SPKI, proof algorithm and proof signature.

The Ed25519 proof covers the NUL-separated UTF-8 sequence:

```text
CASSAV5BT-BT-ENROLLMENT-PROOF-V1
protocolVersion
enrollmentEndpointId
token
nodeId
publicKeySpkiDerBase64
```

Both sides reject extra, missing or duplicate JSON fields. Duplicate detection
is performed after decoding escaped key names. Canonical token, lowercase UUID,
44-byte Ed25519 SPKI and 64-byte Ed25519 signature encodings are required.

## Shared and Raspberry transport

`shared/provisioning/enrollment-transport-v1.mjs` implements:

- `POST /v1/enroll` with exact `application/json` media type;
- a 4096-byte request limit;
- endpoint, token, NodeId, public-key and proof binding before registry access;
- generic, non-enumerating registry rejection responses;
- `201` JSON success responses with `Cache-Control: no-store`;
- `GET /health` for the isolated component;
- idempotent recovery for a response lost after commit, limited to 600 seconds
  and to the exact endpoint, token, NodeId and public key;
- registry readiness inspection on `/health`, with `503 NOT_READY` when the
  private V5BT registry is not usable;
- a default limit of four concurrent enrollment operations. Saturation returns
  `503 ENROLLMENT_BUSY`, `Connection: close` and `Retry-After: 1`.

The exact signed request is bearer-equivalent for recovery of the already
committed response during the 600-second window. It must never be logged,
retained by an intermediary or copied into test evidence. This limitation does
not permit a second enrollment, but it remains a security property of the
recovery design.

`raspberry/scripts/enrollment-server.mjs` provides a separate HTTPS process.
It permits TLS 1.3 only, does not request a client certificate, reads the
private key without following symlinks and requires that key to be owned by the
service user with mode `0600`. Startup is fail-closed unless
`CASSA_BT_ENROLLMENT_RUNTIME_ENABLED=1`.

Startup also requires an initialized mode-`0600` registry below the fixed
`/var/lib/cassav5bt-bluetooth` root. V4 paths, intermediate symlinks and
hard-link escapes are rejected. The HTTPS process is limited to 32
connections, five-second headers, ten-second requests, one-second keep-alive
and ten requests per socket.

The systemd example keeps that flag at `0`, applies service hardening and uses
loopback as the default listen host. A LAN bind must therefore be an explicit
Lab configuration. The enrollment endpoint is independent from BlueZ, GATT,
the POS backend and the normal V5BT radio runtime. The unit creates the
isolated `/var/lib/cassav5bt-bluetooth` state root with mode `0700`.
It also caps the service with `MemoryMax=128M`, `CPUQuota=50%`,
`TasksMax=64` and `LimitNOFILE=256`.

`configs/cassav5bt-bluetooth-enrollment.env.example` is the concrete
`EnvironmentFile` template consumed by the unit. It uses systemd `KEY=VALUE`
syntax and contains only V5BT state, registry and `/etc/cassav5bt` TLS paths.
Its install destination is
`/etc/cassav5bt/cassav5bt-bluetooth-enrollment.env`; the installed file must
be a regular `root:root` file with mode `0600`. The template keeps both the
Bluetooth feature flag and the enrollment runtime flag at `0`, and keeps the
listener on `127.0.0.1`. Installing it therefore does not enable or expose the
endpoint.

## Native Android path

Palmare Advanced and Postazione Advanced contain the same native enrollment
protocol, client and coordinator. The local path:

1. consumes an explicit app-private QR input;
2. creates or inspects the local Android Keystore identity;
3. signs the frozen request proof with the non-exportable Ed25519 key;
4. connects only to the configured HTTPS endpoint using TLS 1.3;
5. validates the configured leaf SPKI SHA-256 pin while retaining normal
   hostname/SAN verification;
6. imports the exact enrollment response and reaches identity `READY`;
7. writes only redacted app-private status and never exposes credentials to a
   WebView bridge.

Retry is deliberately narrow. The app can claim enrollment only from
`ALIAS_KEY_UNPROVISIONED` or `ENROLLMENT_PENDING`; a pending identity without
an aliasKey must retain the canonical NodeId/SPKI binding of the current
identity. If cleanup or replacement of the private QR input fails, the
coordinator returns redacted `STORAGE_FAILED` before any network request.

Redirects, proxies and automatic retries are disabled. Enrollment is enabled
only when both the dedicated Lab build gate and the enrollment flag are true.
The standard Advanced build defaults remain off and keep endpoint URL and pin
empty.

## Local validation evidence

Commands:

```text
node --test shared/provisioning/enrollment-transport-v1.test.mjs
node --test shared/provisioning/device-registry-v1.test.mjs
node --test raspberry/scripts/enrollment-server.test.mjs
node --test scripts/run-b2-android-adb-harness.test.mjs
node scripts/run-b2-android-adb-harness.mjs --self-test
node scripts/run-b2-android-gate.mjs --self-test
node scripts/validate-contracts.mjs --root .
node scripts/validate-roadmap-package.mjs --root .
node raspberry/scripts/enrollment-server.mjs
```

Results at this increment:

- enrollment transport: 12 passed, 0 failed;
- device registry including exact committed-response recovery: 20 passed,
  0 failed;
- enrollment server startup and V5BT state-isolation tests: 4 passed, 0 failed;
- Android/ADB harness tests: 16 passed, 0 failed;
- single-device harness self-test: 7 checks, PASS;
- reciprocal two-device gate self-test: 48 checks, PASS;
- semantic contract validation: 15 JSON contracts, PASS;
- roadmap package validation: PASS;
- environment template and enrollment unit V5BT-isolation validation: PASS;
- enrollment server with the runtime flag unset: clean disabled exit, no
  listener opened.

Android parser, proof, config and coordinator tests are present in both
Advanced applications. Their final clean-build and APK evidence is maintained
with the application build report and does not substitute for physical
Android Keystore or TLS evidence.

At evidence time `adb devices -l` returned no attached devices. A new
read-only connection attempt to the Lab Raspberry at `192.168.1.79` failed
with `No route to host`. Therefore no real certificate, pin, socket,
enrollment or packet capture was exercised by these local results.

## Pending evidence

The complete B1 gate remains `PENDING` until all of these are captured:

- a real Lab TLS certificate whose SAN matches the exact client hostname or IP;
- the corresponding leaf SPKI SHA-256 pin in Lab-only app configuration;
- an isolated V5BT enrollment endpoint started and tested end to end without
  touching the active V4 service, server or database;
- Android Keystore creation, Ed25519 proof signing, HMAC key import and
  `READY` recovery on each certified physical Android model;
- target-filesystem process-kill and power-loss recovery evidence;
- redacted proof that no token, alias key or private key enters logs, command
  arguments or WebView surfaces;
- restoration of network reachability to the isolated Lab endpoint and
  attachment/authorization of the certified Android devices.

The B2 physical gate also remains `PENDING`. It still requires reciprocal BLE
discovery measurements, controller packet capture, lifecycle/permission
recovery and the device capability matrix on the certified hardware. A local
enrollment success, scheduler result or unit test cannot close that gate.

## V4 isolation and rollback

No deployment, file write, service restart or database operation in this
increment targeted `192.168.1.79`. Health checks, if performed, are read-only.
The new EnvironmentFile is an uninstalled template inside the roadmap
package. The active V4 installation is untouched.

Rollback is to keep the Lab/enrollment flags false, leave the separate systemd
unit disabled and remove the additive V5BT enrollment contract, transport and
app source. No V4 rollback is required.
