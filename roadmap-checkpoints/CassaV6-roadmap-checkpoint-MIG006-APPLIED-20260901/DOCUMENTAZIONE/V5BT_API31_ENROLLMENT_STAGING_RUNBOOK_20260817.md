# V5BT API31 enrollment staging runbook

## Scope

This procedure stages the API31 enrollment endpoint on Raspberry
`192.168.1.79` without installing a persistent unit and without stopping or
restarting `cassav5bt.service` or `bluetooth.service`.

The helper is `tools/run-v5bt-api31-enrollment-staging.sh`. Do not use the
older shared enrollment deployment helper for this test. The staging endpoint
is isolated on TCP `9443`, uses endpoint ID
`v5bt-api31-enrollment-v2`, and accepts enrollment protocol v1 and v2 while
advertising v2 as preferred.

## Isolation model

- The release is copied to a new root-owned, read-only directory below
  `/opt/cassav5bt-api31-enrollment-staging/releases/<run-id>`.
- Every runtime source file is sealed by `RELEASE.sha256`; start and health
  refuse an altered release.
- The operational registry is read once and copied to
  `/var/lib/cassav5bt-bluetooth/api31-staging-<run-id>/devices.json`.
- The copy is a new regular file, not a hardlink or symlink. A before/copy/after
  SHA-256 check rejects a torn snapshot.
- A private baseline requires the operational registry to remain byte-identical
  through prepare, start, health and stop.
- Registry/service/release/TLS baselines live in a separate root-owned `0700`
  control directory. The enrollment process cannot traverse or modify it.
- The dedicated certificate and key are copied into the private run directory.
  Their contents are never accepted on argv or printed.
- `systemd-run` creates one bounded transient unit as user `cassav5bt`. It has
  no restart policy, a two-hour maximum runtime and a ten-second stop deadline.
- Private service snapshots detect any PID, restart counter, invocation or
  monotonic-start change in the two operational services.

The copied schema-v1 registry may be migrated to schema v2 by the isolated
server. That mutation is confined to the run directory.

## Offline validation

Before any Raspberry access:

```bash
bash tools/run-v5bt-api31-enrollment-staging.sh validate-source
node --test tests/run-v5bt-api31-enrollment-staging.test.mjs
```

The certificate must be currently valid, cover `192.168.1.79`, allow TLS
server use and match the private key. The source private key must not be
group/world accessible.

## Physical procedure

Use one unique lowercase run ID. Supply only filesystem paths through the
environment; never put a private-key value or enrollment token in a command.

```bash
sudo env \
  CASSAV5BT_API31_CERT_SOURCE=/root/v5bt-private/enrollment.crt \
  CASSAV5BT_API31_KEY_SOURCE=/root/v5bt-private/enrollment.key \
  tools/run-v5bt-api31-enrollment-staging.sh prepare 20260817-api31a

sudo tools/run-v5bt-api31-enrollment-staging.sh start 20260817-api31a
sudo tools/run-v5bt-api31-enrollment-staging.sh health 20260817-api31a
sudo tools/run-v5bt-api31-enrollment-staging.sh status 20260817-api31a
```

Start the Android and Raspberry continuity monitors before `start`. After the
health PASS, issue a v2 token only against the copied registry:

```bash
sudo tools/run-v5bt-api31-enrollment-staging.sh \
  issue-token 20260817-api31a tablet-api31
```

The helper fixes protocol v2 and a 600-second TTL, writes the handoff as a new
private `0600` file below the run directory, and suppresses all CLI output. The
token value is never written to shell history, argv, journal or an exported
report. Transfer only `qrPayload` into the Android app's private input using a
separate approved ADB step; do not print it while doing so.

The API31 Android build must pin the same dedicated certificate and use:

```text
https://192.168.1.79:9443/v2/enroll
```

The staging health response must contain exactly protocol versions `[1,2]`,
preferred version `2`, and `registryReady: true`.

## Stop and evidence

Stop always targets only the transient unit derived from the run ID:

```bash
sudo tools/run-v5bt-api31-enrollment-staging.sh stop 20260817-api31a
```

The helper waits at most ten seconds before killing only that transient unit.
It then rechecks both operational services and the byte identity of the main
registry. The copied registry and release remain available for private review.

After private evidence has been hashed and retained elsewhere, removal is an
explicit separate action:

```bash
sudo env CASSAV5BT_API31_PURGE=YES \
  tools/run-v5bt-api31-enrollment-staging.sh purge 20260817-api31a
```

Purge refuses active/mounted staging paths and runs the same service and main
registry checks before removal.

## Stop criteria

Stop immediately and do not claim physical PASS if any of these occurs:

- health is not the exact v1/v2 contract;
- the operational registry hash changes from the private baseline;
- `cassav5bt.service` or `bluetooth.service` changes state, PID, invocation,
  restart count or monotonic start time;
- the transient service exceeds its cleanup window;
- release integrity, ownership, mode, single-link or canonical-path checks fail;
- Android identity, enrollment binding, process continuity or TLS pin checks
  fail.

This staging validates HTTPS enrollment only. Full Bluetooth mutual
authentication is not a gate result unless the GATT runtime deliberately uses
the same isolated registry under a separately approved procedure.
