# V5BT B3 Android Foreground-Service Gate

`scripts/run-b3-android-service-gate.mjs` measures the native V5BT Android
connectivity agent on the two fixed Advanced Lab targets. The physical
observation lasts exactly 3,600 seconds and covers only the B3 service and
lifecycle boundary. The fixed timer starts only after both apps have published
their first valid status, received Android HOME and passed the initial
foreground-service audit.

The harness does not install APKs, grant permissions, stage enrollment input,
open a GATT session, contact Raspberry, restart V5BT or modify its database. It
force-stops only the two selected Advanced Lab packages, removes only the fixed
B3 diagnostic status names from each package-private `no_backup` directory,
captures a current-user `ApplicationExitInfo` baseline, launches the apps,
sends HOME, polls their private status with `run-as`, audits the foreground
service, captures final process-exit information and force-stops them after the
measurement.

## Fixed certification targets

Physical mode accepts only this role mapping:

```text
Palmare
  ADB serial       RFGYA0ZAGFW
  model            SM-A165F
  package          com.sentrapa.palmare.advanced
  versionCode      40
  versionName      1.0.39
  SHA-256          d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65
  artifact         artifacts/Palmare-Advanced-v1.0.39-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk

Postazione
  ADB serial       R9WT50ZN5VZ
  model            SM-T503
  package          com.sentrapa.postazione.advanced
  versionCode      25
  versionName      2.0.23
  SHA-256          3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5
  artifact         artifacts/Postazione-Advanced-v2.0.23-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk
```

La mappatura software e caricata esclusivamente da
`configs/advanced-certification-targets.json`, con validazione fail-closed.
Il preflight richiede un solo `base.apk` e confronta il suo `sha256sum` con il
digest della matrice; una build con la stessa versione ma byte diversi viene
rifiutata.

Prima di aggiornare la Postazione, il rollback APK estratto dal tablet e il
target certificato devono inoltre avere lo stesso certificato restituito da
`apksigner verify --print-certs`. Un mismatch e uno stop bloccante: non sono
ammessi uninstall, `pm clear`, downgrade o nuova enrollment per aggirarlo.

Both APKs must be debuggable Lab builds. Android API 33 or newer, BLE hardware,
an enabled Bluetooth adapter and the following grants are required for the
current Android user:

```text
android.permission.BLUETOOTH_SCAN
android.permission.BLUETOOTH_ADVERTISE
android.permission.BLUETOOTH_CONNECT
```

The harness never grants a missing permission. A user switch during the
measurement fails the gate.

## App-private status contract

Each app must atomically publish:

```text
no_backup/bluetooth-connectivity-agent-status-v1.json
```

The accepted JSON object has exactly these fields and no others:

```json
{
  "schemaVersion": 1,
  "source": "V5BT_ANDROID_CONNECTIVITY_AGENT",
  "labBuild": true,
  "diagnosticsEnabled": true,
  "agentEnabled": true,
  "sampleSequence": 1,
  "sampledAtEpochMs": 1784500000000,
  "reporterStartedAtEpochMs": 1784500000000,
  "state": "DISCOVERING",
  "metrics": {
    "startCount": 1,
    "stopCount": 0,
    "backoffCount": 0,
    "transitionCount": 1,
    "duplicateEventCount": 0,
    "invalidTransitionCount": 0
  },
  "resources": {
    "scannerActive": true,
    "advertiserActive": true,
    "gattServerActive": false,
    "gattClientActive": false,
    "sessionCount": 0
  }
}
```

`state` accepts only:

```text
DISABLED
PERMISSION_REQUIRED
STARTING
DISCOVERING
DIRECT_SERVER
PEER_CONNECTED
DEGRADED
BACKOFF
STOPPED
```

The full enum is parsed so an out-of-scope state is reported precisely.
Physical B3 nevertheless fails immediately on `STOPPED`, `DIRECT_SERVER` or
`PEER_CONNECTED`. It also fails if `startCount` differs from one, `stopCount`
or `invalidTransitionCount` is nonzero, either GATT resource becomes active,
or `sessionCount` becomes nonzero.

All metric counters are non-negative aggregate integers. With an increasing
`sampleSequence`, `sampledAtEpochMs` must increase and no counter may regress.
The reporter start timestamp must remain identical for the entire run. Reusing
a sequence with different content, restarting the reporter, publishing stale
data or going silent for 30 seconds fails closed.

Unexpected status fields are rejected rather than copied. Fields whose names
look like a serial, NodeId, alias, token, key, certificate, MAC/Bluetooth
address or enrollment value are forbidden.

## Background and Android runtime checks

Once both initial status files are valid, the harness sends:

```text
adb shell input keyevent KEYCODE_HOME
```

to both current Android users. The 3,600-second observation begins after HOME
and an initial successful runtime audit, so foreground activity is not used as
the measured lifecycle condition.

At startup, every 60 seconds and after the fixed observation window, the
harness reads `dumpsys activity -a services PACKAGE`. The full (`-a`) dump
guarantees that `isForeground` and `types` are present. It selects exactly one
`BluetoothFailoverService` record belonging to the already verified current
user and requires:

```text
isForeground=true
dataSync type present
connectedDevice type present whenever scanner, advertiser, GATT client or
GATT server resources are reported active
```

A missing or ambiguous service record, an unavailable service-type mask, a
background service, a missing `dataSync` type or a missing `connectedDevice`
type during radio activity fails closed. The current Android user is checked
again with every runtime audit. A locally passing 3,600-second report requires
at least 61 successful service audits per app: one before the timer and one
for each 60-second boundary, including the final boundary.

Immediately after the initial force-stop/reset and before launch, the harness
captures `dumpsys activity exit-info PACKAGE` as a baseline. After the final
foreground-service audit and before cleanup force-stop, it captures the same
current-user history again. A newly observed Java crash, native crash or ANR
(`ApplicationExitInfo` reasons 4, 5 or 6) fails the run. Records already in the
baseline and non-fatal exits such as the harness force-stop do not fail it.
Raw service dumps, exit records, process names, timestamps and PIDs are never
written to the JSON report.

## Offline checks

From the roadmap package root:

```bash
node --check scripts/run-b3-android-service-gate.mjs
node --test scripts/advanced-certification-targets.test.mjs
node scripts/run-b3-android-service-gate.mjs --self-test
node --test scripts/run-b3-android-service-gate.test.mjs
node scripts/run-b3-android-service-gate.mjs \
  --dry-run \
  --handheld-serial RFGYA0ZAGFW \
  --station-serial R9WT50ZN5VZ
```

`--self-test` and `--dry-run` are offline. They do not invoke the configured
ADB executable. There is deliberately no duration option: a shorter physical
run cannot be represented as B3 evidence.

The current certification-matrix plus B3 test set passes `32/32`. The shared
Lab radio coordinator also has an 8-second advertising hysteresis: its first
accepted observation arms the deadline once, duplicates do not extend it and
FAILOVER, stop or a generation change invalidate it. A close race reports
`ABORTED`, distinct from a real `FAILED` scheduling result. These offline
checks do not replace the 3,600-second physical observation.

## Physical command

```bash
node scripts/run-b3-android-service-gate.mjs \
  --handheld-serial RFGYA0ZAGFW \
  --station-serial R9WT50ZN5VZ \
  --output reports/physical/v5bt-b3-android-service.json
```

`--poll-ms` may be set from 1,000 through 30,000 milliseconds. It changes only
the polling cadence, never the 3,600-second requirement.

The preflight checks both ADB targets and roles, exact model/package/version,
Android API, BLE, adapter state, current-user permissions and current-user
`run-as`. After clearing the old B3 status, samples must be fresh, monotonic
and come from the same reporter for the complete measurement. Both apps remain
backgrounded while periodic service-type and current-user checks run.

## Evidence and redaction

The JSON report contains roles, boolean verification results, Android API,
aggregate counters, observed state names and aggregate resource results. It
also contains HOME/background confirmation, aggregate foreground-service audit
counts and boolean baseline/final exit-audit results. It does not contain
either ADB serial, NodeId, BLE address, alias, enrollment material,
cryptographic material or raw Android dumps. Output files are written
atomically with mode `0600`; an existing symlink or non-regular output path is
rejected.

Even after all local physical measurements pass, the harness emits:

```text
localMeasurementVerdict = PASS
gate = PENDING
physicalCertificationPassEmittedByHarness = false
```

The B3 gate may be closed only after the real two-target evidence is reviewed
and recorded in a separate phase-gate report. Self-test and dry-run evidence
can never close B3.

Exit codes:

```text
0  self-test, dry-run or help completed
1  argument, preflight, status, duration or runtime failure
2  physical measurement passed locally; B3 gate remains PENDING for review
```

If either Advanced app does not publish the exact private status contract,
physical mode fails with `LAB_STATUS_UNAVAILABLE`; it never converts missing
physical evidence into a simulated pass.

As of 2026-08-04 B3 has not been started because the certified Postazione
tablet is unavailable. The two-Palmare B2 diagnostic cannot substitute the
fixed Palmare/Postazione role mapping, so B3 remains `PENDING`.

Dal 2026-08-05 i target richiesti sono Palmare `1.0.39` code `40` e
Postazione `2.0.23` code `25`. Le rispettive suite Android chiudono `212/212`
e `196/196`, entrambe con lint a zero errori. Le regressioni fisiche su due
Palmare restano `NON_GATE_EVIDENCE` e non sostituiscono l'osservazione B3 di
3.600 secondi. Ogni acquisizione precedente con build diverse e storica; B3
deve essere eseguito integralmente con la coppia certificata e resta
`PENDING`.
