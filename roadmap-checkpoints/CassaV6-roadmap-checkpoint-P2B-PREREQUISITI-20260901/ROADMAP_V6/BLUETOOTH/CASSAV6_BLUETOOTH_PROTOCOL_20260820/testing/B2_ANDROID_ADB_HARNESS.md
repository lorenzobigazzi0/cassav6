# V6 B2 Android/ADB Physical-Test Harness

`scripts/run-b2-android-adb-harness.mjs` prepares and measures one Android Lab
node without exposing enrollment material in command arguments or reports. It
does not install an APK, grant permissions, connect to Raspberry, deploy a
service, restart the V6 service or modify the V6 database.

## Required Lab build

The installed APK must be debuggable and must use its Advanced application ID:

```text
Palmare Advanced
  packageId       com.sentrapa.palmare.advanced
  versionName     1.0.39
  versionCode     40
  SHA-256         d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65
  artifact        artifacts/Palmare-Advanced-v1.0.39-V6-B0-B2-Cooldown-Lab-20260805-debug.apk

Postazione Advanced
  packageId       com.sentrapa.postazione.advanced
  versionName     2.0.23
  versionCode     25
  SHA-256         3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5
  artifact        artifacts/Postazione-Advanced-v2.0.23-V6-B0-B2-Cooldown-Lab-20260805-debug.apk
```

La fonte unica di questi metadati e
`configs/advanced-certification-targets.json`. Entrambi i gate B2 e B3 la
caricano con schema chiuso e falliscono prima di ADB se il file e assente,
illeggibile, simbolico, troppo grande o contiene campi e valori non validi.

The Lab, identity, discovery, diagnostics and enrollment build flags must be
enabled for initial enrollment. The enrollment URL, endpoint identifier, TLS
hostname/SAN and leaf SPKI pin must match the isolated V6 Lab endpoint.
Standard Advanced APKs keep these features disabled and cannot produce this
evidence.

The preflight is fail-closed. It checks:

- the exact explicit ADB serial is connected and authorized;
- the product model is readable and, when supplied, exactly matches
  `--expected-model`;
- Android API is at least 33;
- `android.hardware.bluetooth_le` exists and Bluetooth is enabled;
- the exact Advanced package, version and single-APK layout exist;
- `sha256sum` of the installed `base.apk` exactly matches the certified
  artifact digest;
- `run-as` reaches the private UID, proving that a debuggable Lab APK is
  installed;
- `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE` and `BLUETOOTH_CONNECT` are granted
  for the current Android user.

The harness never grants a permission automatically. Grant it through the
normal Lab setup and repeat the preflight.

## Offline validation

From the roadmap package root:

```bash
node scripts/run-b2-android-adb-harness.mjs --self-test
node --test scripts/run-b2-android-adb-harness.test.mjs
node --test scripts/advanced-certification-targets.test.mjs
node scripts/run-b2-android-gate.mjs --self-test
node --test scripts/run-b2-android-gate.test.mjs
```

All five commands are offline. They do not invoke ADB or SSH. The current
matrix suite passes `6/6`, the ADB harness `29/29`, the reciprocal gate
`13/13` and its self-test `151/151`. Build consistency passes `9/9`.

La ricertificazione applicativa corrente del 2026-08-05 chiude Palmare Android
`212/212` e Postazione Android `196/196`, con lint a `0` errori. La Postazione
e stata compilata ma non installata perche il tablet certificato era assente.
La regressione fisica di logout e le prove su due Palmare restano
`NON_GATE_EVIDENCE`; B2 resta `PENDING`.

## Initial enrollment run

Keep each enrollment QR in an access-controlled file and pass only its path.
The token itself must never be placed in the shell command:

```bash
chmod 600 /secure/path/palmare-enrollment-qr.json
node scripts/run-b2-android-adb-harness.mjs \
  --serial RFGYA0ZAGFW \
  --expected-model SM-A165F \
  --package com.sentrapa.palmare.advanced \
  --qr-file /secure/path/palmare-enrollment-qr.json \
  --discovery-seconds 30 \
  --output reports/physical/palmare-b2.json
```

For a path source, the harness opens without following a final symlink,
requires a regular file owned by the current user, accepts only mode `0400` or
`0600`, checks the 512-byte bound before reading and detects a file changed
during the read. An insecure source fails before ADB is invoked.

Use `--qr-file -` when a trusted scanner or secret-producing process writes
the JSON directly to the harness standard input. The harness validates the
strict three-field QR contract and its 512-byte limit before it touches ADB.

After a successful preflight it:

1. force-stops only the selected Advanced Lab package;
2. clears only fixed diagnostic/input names in that package's private
   `no_backup` directory;
3. streams the QR bytes through standard input of
   `adb shell -T run-as <package> sh -c ...`;
4. atomically installs the private QR file with mode `0600`;
5. starts the package launcher, which initializes the app-owned non-exported
   foreground service;
6. polls the allowlisted redacted enrollment and discovery status schemas
   through `exec-out run-as`;
7. emits a JSON report containing no token, alias key, public key, private key,
   NodeId or BLE address.

The QR bytes never occur in the ADB argument vector. The in-process byte buffer
is overwritten after staging. Android consumes the private input once.

`ALREADY_PROVISIONED` e un esito distinto e fallisce la prova di enrollment:
non dimostra che il QR appena fornito sia stato inviato o che il relativo token
sia stato consumato. La chiusura B1 richiede inoltre evidenza amministrativa
redatta dal registry V6 che l'esatto token sia `CONSUMED` dal nuovo NodeId.

## Discovery-only repeat

After both physical devices have a `READY` identity, run one harness process
per device at the same time:

```bash
node scripts/run-b2-android-adb-harness.mjs \
  --serial RFGYA0ZAGFW \
  --expected-model SM-A165F \
  --package com.sentrapa.palmare.advanced \
  --skip-enrollment \
  --discovery-seconds 120 \
  --output reports/physical/palmare-b2-repeat.json
```

Run the equivalent command for Postazione Advanced with its own serial,
package and expected model. `--skip-enrollment` does not read, stage or delete
enrollment input/status. It resets only the discovery diagnostic file.

A single-device `PASS` proves only that this node became ready, advertised,
scanned, observed at least one valid V6 advertisement, stayed free of
reported radio/drop failures and measured discovery p95 at or below 8000 ms.
It does not close B2 by itself. Gate closure still requires two reciprocal
reports correlated by time and a controller capture, plus lifecycle and
permission-recovery evidence.

## Reciprocal 100-cycle gate

`scripts/run-b2-android-gate.mjs` is bound to the certified Palmare and
Postazione target model, package, version and APK SHA-256. It uses the current
Android user for permission and `run-as` checks, then requires exactly 100
complete cycles.
Each cycle must contain fresh samples with increasing sequence from the same
reporter, actual scan and advertising activity, anonymous peer presence and
zero critical radio/drop counters.

Il contratto formale schema 7 richiede inoltre esattamente 100 finestre di
quiescenza misurate, una prima di ogni ciclo. La prima segue il `force-stop`
iniziale di entrambi i target; le altre 99 iniziano soltanto dopo il
`force-stop` verificato al confine del ciclo precedente. Ogni finestra usa il
clock monotono dell'host e deve avere `observedMs >= requestedMs >= 31.000`.
Una finestra mancante, piu breve o incoerente con la durata configurata
produce `FORMAL_QUIESCENCE_EVIDENCE_INCOMPLETE` e mantiene il verdetto locale
in `PENDING`.

```bash
node scripts/run-b2-android-gate.mjs \
  --handheld-serial RFGYA0ZAGFW \
  --station-serial R9WT50ZN5VZ \
  --cycles 100 \
  --formal-quiescence-ms 31000 \
  --rf-evidence /secure/path/b2-controlled-rf.evidence \
  --capture-evidence /secure/path/b2-controller.capture \
  --output /secure/path/b2-formal.json
```

`--formal-quiescence-ms` puo aumentare la durata fino a `120.000` ms. La
modalita formale rifiuta `--cycle-gap-ms`: un intervallo non misurato non puo
sostituire una finestra di quiescenza. I file RF, capture e output devono
restare distinti; le evidenze esterne devono essere file regolari, a link
singolo, di proprieta dell'operatore e con permessi `0600`.

The output intentionally separates `localMeasurementVerdict` from `gate`.
Even when every local measurement passes, `gate` remains `PENDING` until
nonempty, distinct RF and controller capture files have been reviewed by an
independent operator. The redacted reciprocal report never emits either ADB
serial.

### Two-handheld diagnostic

When the certified Postazione is unavailable, two distinct Palmare targets
may run a discovery-only diagnostic without changing the formal Palmare /
Postazione mapping:

```bash
node scripts/run-b2-android-gate.mjs \
  --diagnostic-handheld-pair \
  --handheld-a-serial SERIAL_A \
  --handheld-b-serial SERIAL_B \
  --cycles 100 \
  --output /secure/path/b2-two-handheld-diagnostic.json
```

A physical diagnostic requires exactly 100 cycles, two different explicit
ADB serials, the certified Palmare package/build on both devices and an
already `READY` identity. It rejects formal-target options, RF evidence and
controller-capture imports. Its output is always `NON_GATE_EVIDENCE`, keeps
B2 `PENDING`, is redacted, is created with mode `0600` and cannot overwrite an
existing path.

Every cycle intentionally stops the selected package at its boundaries,
removes only the private discovery-status files, relaunches the app and
requires fresh live status from both reporters. A reporter restart inside a
cycle invalidates that cycle; the expected restart between cycles is recorded
separately. The diagnostic never uninstalls an app, clears application data,
stages enrollment material or changes either identity. Both selected packages
are left stopped after final cleanup and must be relaunched normally before
returning them to service.

### Cooldown pilot da 20 cicli

Per distinguere la latenza di rendezvous dallo stato radio residuo tra cicli,
il runner espone un pilot fisico dedicato:

```bash
node scripts/run-b2-android-gate.mjs \
  --diagnostic-cooldown-pilot \
  --handheld-a-serial SERIAL_A \
  --handheld-b-serial SERIAL_B \
  --timeout-ms 25000 \
  --output /secure/path/b2-two-handheld-cooldown-pilot.json
```

Il contratto fissa esattamente 20 cicli, una quiescenza iniziale e 19
intervalli tra cicli. Ogni intervallo inizia soltanto dopo che il `force-stop`
di entrambi i Palmare e stato confermato e dura almeno 31.000 ms misurati con
il clock monotono dell'host. `--cycles` e `--cycle-gap-ms` sono vietati in
questa modalita; `--quiescence-ms` puo soltanto aumentare la durata fino a
120.000 ms.

Il report pubblica durata richiesta e osservata per ogni intervallo, stato di
completezza della quiescenza, p95 e ciclo completo. Anche con
`pilotVerdict: PASS` mantiene sempre `gate: PENDING`,
`evidenceClass: NON_GATE_EVIDENCE`, `b2PromotionAllowed: false` e 100 cicli
formali invariati. Il pilot non puo importare evidenze RF, usare la Postazione
formale o essere promosso a B2.

Il giro fisico del 2026-08-05 con Palmare `1.0.39` ha completato `20/20`
cicli, zero timeout o errori radio e tutte le venti quiescenze da almeno
31.000 ms. Il p95 e 5.825 ms, il range 3.486..5.832 ms e il p95 dopo readiness
1.940 ms. Il pilot e `PASS / NON_GATE_EVIDENCE`, quindi B2 resta `PENDING`.
Il dettaglio redatto e in
`reports/physical/V6_B0_B2_COOLDOWN_TWO_HANDHELD_PHYSICAL_20260805.md`.
L'avanzamento roadmap ufficiale resta **49%**.

The current Lab policy keeps advertising in `LOW_LATENCY` for exactly 8,000 ms
after the first accepted peer observation, while scan may enter STABLE
immediately. Duplicate observations and advertisement updates do not extend
the deadline. FAILOVER, stop and generation changes invalidate it. A callback
cancelled by a concurrent close is `ABORTED`; only a real scheduling failure
is `FAILED` and enters radio backoff.

Every newly generated B2 report uses schema 7 and contains
`certificationMatrixBinding`: a public, canonical SHA-256 binding to the
strictly validated Advanced target matrix, including package, version, code,
artifact-relative path and APK SHA-256 for both roles. The binding contains no
serial, enrollment or private device data. Schema 7 adds the fail-closed formal
quiescence contract and its 100 measured intervals. Historical schema 5 and 6
evidence is not rewritten and must be interpreted together with its original
inventory.

The schema 5 diagnostic of 2026-08-04 completed `100/100` cycles with 95 pass
and 5 timeout cycles. Its p95 was 19,145 ms, or 14,271 ms after both reporters
were ready, against the required maximum of 8,000 ms. Timeout attribution was
3 for `handheld_a` and 2 for `handheld_b`; scan, advertising, ingress and
payload error counters remained zero. This is `NON_GATE_EVIDENCE`: B2 remains
`PENDING` and B3 was not started without the certified Postazione tablet.

## Dry run and exit codes

Add `--dry-run` to validate arguments and QR locally and print the exact
secret-free command plan without executing ADB:

```bash
node scripts/run-b2-android-adb-harness.mjs \
  --serial RFGYA0ZAGFW \
  --package com.sentrapa.palmare.advanced \
  --qr-file /secure/path/palmare-enrollment-qr.json \
  --dry-run
```

Exit codes:

```text
0  single-node PASS, dry-run PASS or self-test PASS
1  preflight, enrollment, radio, latency or harness failure
2  PENDING because no reciprocal peer observation was measured
```

Every status file is parsed against an explicit field allowlist. Unexpected
fields cause failure instead of being copied into the report.
`STORAGE_FAILED` is terminal and means the app refused network enrollment
because it could not securely remove or replace the private QR input.

## Optional Raspberry btmon plan

`--btmon-ssh-target user@host` adds a non-executing helper plan to the JSON
report:

```bash
node scripts/run-b2-android-adb-harness.mjs \
  --serial RFGYA0ZAGFW \
  --package com.sentrapa.palmare.advanced \
  --skip-enrollment \
  --dry-run \
  --btmon-ssh-target admin@192.168.1.79 \
  --btmon-seconds 130
```

The plan uses `ssh -T`, `sudo -n`, `timeout` and `btmon`, and recommends
redirecting stdout to a local protected evidence file. It contains no password
and the harness never executes it. Running a controller capture must be an
explicit operator action after confirming that it is read-only and isolated
from the active V6 service.
