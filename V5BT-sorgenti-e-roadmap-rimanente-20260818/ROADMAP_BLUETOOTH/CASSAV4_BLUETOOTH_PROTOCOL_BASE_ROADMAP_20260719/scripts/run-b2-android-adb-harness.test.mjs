import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  B2_DISCOVERY_P95_TARGET_MS,
  DISCOVERY_STATUS_FILE,
  AdbClient,
  HarnessError,
  assertReportContainsNoEnrollmentToken,
  buildBtmonPlan,
  buildPrivateCleanupArgs,
  buildPrivateStageArgs,
  evaluateDiscoveryEvidence,
  main,
  parseAdbDevices,
  parseArguments,
  parseBoundInstalledApkSha256,
  parseCertifiedInstalledVersion,
  parseDiscoveryStatus,
  parseEnrollmentStatus,
  parseSingleInstalledApkPath,
  packagePermissionGrantedForUser,
  readSecureQrBytes,
  runPreflight,
  runSelfTest,
  validateEnrollmentQr,
  validateOptions
} from "./run-b2-android-adb-harness.mjs";
import { ADVANCED_CERTIFICATION_TARGETS } from
  "./advanced-certification-targets.mjs";

async function captureProcessOutput(callback) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  };
  try {
    return {
      result: await callback(),
      stdout,
      stderr
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function fixtureToken(byte = 0x4a) {
  return `c5e1_${Buffer.alloc(32, byte).toString("base64url")}`;
}

function validQr(token = fixtureToken()) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      enrollmentEndpointId: "v5bt-lab",
      token
    }),
    "utf8"
  );
}

function discoveryStatus(overrides = {}) {
  const metrics = {
    scanWindowsStarted: 2,
    concurrentScanAdvertiseWindowsStarted: 2,
    scanWindowsCompleted: 1,
    scanFailures: 0,
    advertisementsStarted: 1,
    advertisementUpdates: 2,
    advertisementFailures: 0,
    invalidPayloads: 0,
    acceptedObservations: 1,
    scanIngressDropped: 0,
    peerExpiryCount: 0,
    firstObservationOffsetP95Ms: 1_500,
    peerDirectory: {
      added: 1,
      updated: 0,
      duplicateRefreshes: 0,
      belowRssiFloor: 0,
      olderRejected: 0,
      ambiguousRejected: 0,
      conflicts: 0,
      directoryFull: 0,
      newStreamAttemptRateRejected: 0,
      capacityEvicted: 0,
      clockRegressions: 0,
      expired: 0,
      prunePasses: 1,
      newStreamAttempts: 1,
      newStreamsAccepted: 1,
      newStreamAttemptWindowsStarted: 1,
      capacityHighWatermark: 1
    },
    ...overrides.metrics
  };
  return {
    schemaVersion: 1,
    source: "V5BT_ANDROID_DISCOVERY_LAB",
    labBuild: true,
    diagnosticsEnabled: true,
    sampleSequence: 4,
    sampledAtEpochMs: 1_000,
    reporterStartedAtEpochMs: 500,
    readiness: "READY",
    ready: true,
    radioActive: true,
    scanProfile: "FAILOVER",
    activePeerCount: 1,
    metrics,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "metrics")
    )
  };
}

class CertifiedPreflightAdbFixture {
  constructor(overrides = {}) {
    this.serial = "CERTIFIED_SERIAL";
    this.calls = [];
    this.target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
    this.overrides = overrides;
    this.currentUserReads = 0;
    this.packagePathReads = 0;
  }

  serialArgs(...args) {
    return ["-s", this.serial, ...args];
  }

  result(stdout = "") {
    return { ok: true, code: null, stdout, stderr: "", status: 0 };
  }

  run(args) {
    this.calls.push(args);
    const command = args[0] === "-s" ? args.slice(2) : args;
    if (command[0] === "version") return this.result("Android Debug Bridge version 1\n");
    if (command[0] === "devices") {
      return this.result(
        `List of devices attached\n${this.serial} device model:SM_A165F\n`
      );
    }
    if (command[0] === "shell" && command[1] === "dumpsys") {
      const versionName = this.overrides.versionName ?? this.target.versionName;
      const versionCode = this.overrides.versionCode ?? this.target.versionCode;
      return this.result([
        `  versionCode=${versionCode} minSdk=33 targetSdk=36`,
        `  versionName=${versionName}`,
        "  User 0: ceDataInode=1",
        "    runtime permissions:",
        "      android.permission.BLUETOOTH_SCAN: granted=true, flags=[]",
        "      android.permission.BLUETOOTH_ADVERTISE: granted=true, flags=[]",
        "      android.permission.BLUETOOTH_CONNECT: granted=true, flags=[]"
      ].join("\n"));
    }
    throw new Error(`unexpected run call: ${JSON.stringify(args)}`);
  }

  shell(...args) {
    this.calls.push(this.serialArgs("shell", ...args));
    if (args[0] === "getprop" && args[1] === "ro.product.model") {
      return this.result("SM_A165F\n");
    }
    if (args[0] === "getprop" && args[1] === "ro.build.version.sdk") {
      return this.result("36\n");
    }
    if (args[0] === "am" && args[1] === "get-current-user") {
      this.currentUserReads += 1;
      return this.result(
        this.currentUserReads > 1 && this.overrides.currentUserAfter !== undefined
          ? this.overrides.currentUserAfter
          : this.overrides.currentUser ?? "0\n"
      );
    }
    if (args[0] === "pm" && args[1] === "list") {
      return this.result("feature:android.hardware.bluetooth_le\n");
    }
    if (args[0] === "settings") return this.result("1\n");
    if (args[0] === "pm" && args[1] === "path") {
      this.packagePathReads += 1;
      return this.result(
        this.packagePathReads > 1 && this.overrides.packagePathAfter !== undefined
          ? this.overrides.packagePathAfter
          : this.overrides.packagePath ??
          "package:/data/app/~~test/com.sentrapa.palmare.advanced-test/base.apk\n"
      );
    }
    if (args[0] === "cmd") {
      return this.result(`${this.target.packageId}/.MainActivity\n`);
    }
    if (args[0] === "sha256sum") {
      const apkPath = args[1];
      return this.result(
        this.overrides.shaOutput ?? `${this.target.sha256}  ${apkPath}\n`
      );
    }
    throw new Error(`unexpected shell call: ${JSON.stringify(args)}`);
  }

  execOutRunAs(packageName, ...args) {
    this.calls.push(this.serialArgs("exec-out", "run-as", packageName, ...args));
    return this.result("10234\n");
  }

  execOutRunAsForUser(packageName, currentUser, ...args) {
    return this.execOutRunAs(
      packageName,
      "--user",
      String(currentUser),
      ...args
    );
  }
}

test("parses only one absolute base APK and path-bound SHA output", () => {
  const apkPath = "/data/app/~~test/com.sentrapa.palmare.advanced-test/base.apk";
  const digest = ADVANCED_CERTIFICATION_TARGETS.roles.handheld.sha256;
  assert.equal(parseSingleInstalledApkPath(`package:${apkPath}\n`), apkPath);
  assert.equal(
    parseBoundInstalledApkSha256(`${digest}  ${apkPath}\n`, apkPath),
    digest
  );
  assert.equal(
    parseSingleInstalledApkPath(`package:${apkPath}\npackage:${apkPath}.split.apk\n`),
    null
  );
  assert.equal(
    parseBoundInstalledApkSha256(`${digest}  /data/app/other/base.apk\n`, apkPath),
    null
  );
});

test("parses one unambiguous installed version", () => {
  assert.deepEqual(
    parseCertifiedInstalledVersion(" versionCode=37 minSdk=33\n versionName=1.0.36\n"),
    { versionName: "1.0.36", versionCode: 37 }
  );
  assert.equal(
    parseCertifiedInstalledVersion("versionName=1.0.36\nversionName=1.0.35\nversionCode=37\n"),
    null
  );
});

test("canonical preflight binds current user, build and installed APK to the matrix", async () => {
  const adb = new CertifiedPreflightAdbFixture();
  const report = await runPreflight(adb, {
    serial: adb.serial,
    packageName: adb.target.packageId,
    expectedModel: "SM_A165F"
  });
  assert.equal(report.passed, true);
  assert.equal(report.target.certificationRole, "handheld");
  assert.equal(report.target.certifiedVersion, true);
  assert.equal(report.target.certifiedApkSha256, true);
  assert.equal(
    adb.calls.some((args) =>
      JSON.stringify(args).includes('"pm","path","--user","0"')
    ),
    true
  );
  assert.equal(
    adb.calls.some((args) =>
      JSON.stringify(args).includes('"run-as","com.sentrapa.palmare.advanced","--user","0"')
    ),
    true
  );
});

test("run-as private reads bind the package before the verified Android user", () => {
  const adb = new AdbClient("adb", "SERIAL");
  let captured = null;
  adb.run = (args) => {
    captured = args;
    return { ok: true, code: null, stdout: "{}", stderr: "", status: 0 };
  };
  const result = adb.execOutRunAsForUser(
    "com.sentrapa.palmare.advanced",
    10,
    "cat",
    DISCOVERY_STATUS_FILE
  );
  assert.equal(result.ok, true);
  assert.deepEqual(captured, [
    "-s",
    "SERIAL",
    "exec-out",
    "run-as",
    "com.sentrapa.palmare.advanced",
    "--user",
    "10",
    "cat",
    DISCOVERY_STATUS_FILE
  ]);
});

for (const [name, overrides, failedCheck] of [
  ["versionName mismatch", { versionName: "1.0.35" }, "app.version_name_certified"],
  ["versionCode mismatch", { versionCode: 36 }, "app.version_code_certified"],
  ["split APK layout", {
    packagePath:
      "package:/data/app/test/base.apk\npackage:/data/app/test/split_config.apk\n"
  }, "app.single_apk_layout"],
  ["APK hash mismatch", {
    shaOutput:
      `${"a".repeat(64)}  /data/app/~~test/com.sentrapa.palmare.advanced-test/base.apk\n`
  }, "app.apk_sha256_certified"],
  ["package replacement race", {
    packagePathAfter:
      "package:/data/app/~~replacement/com.sentrapa.palmare.advanced-new/base.apk\n"
  }, "app.package_path_stable"],
  ["current user race", { currentUserAfter: "10\n" }, "device.current_user_stable"]
]) {
  test(`canonical preflight fails closed on ${name}`, async () => {
    const adb = new CertifiedPreflightAdbFixture(overrides);
    const report = await runPreflight(adb, {
      serial: adb.serial,
      packageName: adb.target.packageId
    });
    assert.equal(report.passed, false);
    assert.equal(
      report.checks.find((entry) => entry.id === failedCheck)?.status,
      "FAIL"
    );
  });
}

test("unsupported packages are rejected before the first ADB command", async () => {
  const adb = new CertifiedPreflightAdbFixture();
  const report = await runPreflight(adb, {
    serial: adb.serial,
    packageName: "com.example.uncertified"
  });
  assert.equal(report.passed, false);
  assert.equal(adb.calls.length, 0);
  assert.equal(report.checks[0].id, "app.package_certified");
});

test("validates the exact enrollment QR without returning it in a report", () => {
  const token = fixtureToken();
  const parsed = validateEnrollmentQr(validQr(token));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.enrollmentEndpointId, "v5bt-lab");
  assert.equal(parsed.token, token);
  assert.equal(parsed.byteLength, validQr(token).byteLength);
});

test("rejects duplicate QR fields before touching ADB", () => {
  const raw =
    `{"version":1,"enrollmentEndpointId":"v5bt-lab",` +
    `"token":"${fixtureToken()}","token":"${fixtureToken(0x4b)}"}`;
  assert.throws(
    () => validateEnrollmentQr(Buffer.from(raw)),
    (error) =>
      error instanceof HarnessError && error.code === "QR_JSON_INVALID"
  );
});

test("opens only an owner-only regular QR file without following symlinks", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-qr-security-")
  );
  const securePath = path.join(directory, "enrollment.json");
  const loosePath = path.join(directory, "loose.json");
  const linkPath = path.join(directory, "linked.json");
  try {
    fs.writeFileSync(securePath, validQr(), { mode: 0o600 });
    fs.chmodSync(securePath, 0o600);
    const bytes = readSecureQrBytes(securePath);
    assert.equal(validateEnrollmentQr(bytes).version, 1);
    bytes.fill(0);

    fs.writeFileSync(loosePath, validQr(), { mode: 0o644 });
    fs.chmodSync(loosePath, 0o644);
    assert.throws(
      () => readSecureQrBytes(loosePath),
      (error) =>
        error instanceof HarnessError && error.code === "QR_FILE_INSECURE"
    );

    fs.symlinkSync(securePath, linkPath);
    assert.throws(() => readSecureQrBytes(linkPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stages only through shell -T run-as stdin with no token in argv", () => {
  const token = fixtureToken();
  const args = buildPrivateStageArgs(
    "PALMARE_TEST_SERIAL",
    "com.sentrapa.palmare.advanced"
  );
  assert.deepEqual(args.slice(0, 6), [
    "-s",
    "PALMARE_TEST_SERIAL",
    "shell",
    "-T",
    "run-as",
    "com.sentrapa.palmare.advanced"
  ]);
  assert.equal(JSON.stringify(args).includes(token), false);
  assert.match(args.at(-1), /chmod 600/);
  assert.match(args.at(-1), /cat >/);
  assert.match(args.at(-1), /^'.*'$/s);
});

test("discovery-only cleanup does not remove enrollment state", () => {
  const args = buildPrivateCleanupArgs(
    "POSTAZIONE_TEST_SERIAL",
    "com.sentrapa.postazione.advanced",
    true
  );
  assert.match(args.at(-1), /bluetooth-discovery-status-v1\.json/);
  assert.doesNotMatch(args.at(-1), /bluetooth-enrollment-status-v1\.json/);
});

test("parses authorized and unauthorized ADB inventory entries", () => {
  const devices = parseAdbDevices(
    "List of devices attached\n" +
      "ABC device product:a model:SM-A165F device:a16 transport_id:1\n" +
      "XYZ unauthorized usb:1-1\n"
  );
  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], {
    serial: "ABC",
    state: "device",
    transportModel: "SM-A165F",
    transportProduct: "a",
    transportDevice: "a16"
  });
  assert.equal(devices[1].state, "unauthorized");
});

test("checks Bluetooth permission only inside the current Android user block", () => {
  const dump = [
    "Packages:",
    "  Package [com.sentrapa.palmare.advanced]:",
    "    User 0: ceDataInode=1",
    "      runtime permissions:",
    "        android.permission.BLUETOOTH_SCAN: granted=false, flags=[]",
    "    User 10: ceDataInode=2",
    "      runtime permissions:",
    "        android.permission.BLUETOOTH_SCAN: granted=true, flags=[]"
  ].join("\n");
  assert.equal(
    packagePermissionGrantedForUser(
      dump,
      0,
      "android.permission.BLUETOOTH_SCAN"
    ),
    false
  );
  assert.equal(
    packagePermissionGrantedForUser(
      dump,
      10,
      "android.permission.BLUETOOTH_SCAN"
    ),
    true
  );
});

test("accepts only the redacted enrollment status allowlist", () => {
  const parsed = parseEnrollmentStatus(
    JSON.stringify({
      version: 1,
      status: "READY",
      identityStatus: "READY",
      clientStatus: null,
      parseCode: null,
      httpStatus: null
    })
  );
  assert.equal(parsed.status, "READY");
  assert.equal(
    parseEnrollmentStatus(
      JSON.stringify({
        version: 1,
        status: "STORAGE_FAILED",
        identityStatus: null,
        clientStatus: null,
        parseCode: null,
        httpStatus: null
      })
    ).status,
    "STORAGE_FAILED"
  );
  assert.throws(
    () =>
      parseEnrollmentStatus(
        JSON.stringify({
          version: 1,
          status: "READY",
          identityStatus: "READY",
          clientStatus: null,
          parseCode: null,
          httpStatus: null,
          token: fixtureToken()
        })
      ),
    (error) =>
      error instanceof HarnessError &&
      error.code === "ENROLLMENT_STATUS_INVALID"
  );
});

test("accepts the redacted discovery schema and passes single-node evidence", () => {
  const parsed = parseDiscoveryStatus(JSON.stringify(discoveryStatus()));
  assert.equal(parsed.ready, true);
  assert.equal(parsed.metrics.concurrentScanAdvertiseWindowsStarted, 2);
  assert.deepEqual(evaluateDiscoveryEvidence(parsed, true), {
    status: "PASS",
    code: "SINGLE_NODE_DISCOVERY_EVIDENCE_PASS",
    measuredP95Ms: 1_500,
    targetP95Ms: B2_DISCOVERY_P95_TARGET_MS
  });
});

test("rejects discovery evidence without the cumulative concurrency metric", () => {
  const missing = discoveryStatus();
  delete missing.metrics.concurrentScanAdvertiseWindowsStarted;
  assert.throws(
    () => parseDiscoveryStatus(JSON.stringify(missing)),
    (error) =>
      error instanceof HarnessError &&
      error.code === "DISCOVERY_STATUS_INVALID"
  );
});

test("keeps no-peer discovery pending and fails latency above the target", () => {
  const pending = parseDiscoveryStatus(
    JSON.stringify(
      discoveryStatus({
        metrics: {
          acceptedObservations: 0,
          firstObservationOffsetP95Ms: null
        }
      })
    )
  );
  assert.equal(
    evaluateDiscoveryEvidence(pending, true).status,
    "PENDING"
  );
  const slow = parseDiscoveryStatus(
    JSON.stringify(
      discoveryStatus({
        metrics: {
          firstObservationOffsetP95Ms:
            B2_DISCOVERY_P95_TARGET_MS + 1
        }
      })
    )
  );
  assert.equal(evaluateDiscoveryEvidence(slow, true).status, "FAIL");
});

test("rejects discovery files that add identifiers outside the allowlist", () => {
  assert.throws(
    () =>
      parseDiscoveryStatus(
        JSON.stringify({
          ...discoveryStatus(),
          nodeId: "00000000-0000-4000-8000-000000000000"
        })
      ),
    (error) =>
      error instanceof HarnessError &&
      error.code === "DISCOVERY_STATUS_INVALID"
  );
});

test("report firewall rejects an enrollment token at any nesting level", () => {
  const token = fixtureToken();
  assert.doesNotThrow(() =>
    assertReportContainsNoEnrollmentToken({ tokenIncluded: false }, token)
  );
  assert.throws(
    () =>
      assertReportContainsNoEnrollmentToken(
        { nested: { accidental: token } },
        token
      ),
    (error) =>
      error instanceof HarnessError &&
      error.code === "REPORT_SECRET_DETECTED"
  );
});

test("btmon plan is non-executing and contains no credential", () => {
  const plan = buildBtmonPlan("admin@192.168.1.79", 30);
  assert.equal(plan.executedByHarness, false);
  assert.equal(plan.activeV4Changes, false);
  assert.equal(plan.credentialsEmbedded, false);
  assert.deepEqual(plan.argv.slice(0, 3), [
    "ssh",
    "-T",
    "admin@192.168.1.79"
  ]);
  assert.equal(plan.argv.includes("admin"), false);
});

test("argument validation requires QR only for enrollment mode", () => {
  const skip = validateOptions(
    parseArguments([
      "--serial",
      "ABC",
      "--package",
      "com.sentrapa.palmare.advanced",
      "--skip-enrollment"
    ])
  );
  assert.equal(skip.skipEnrollment, true);
  assert.throws(
    () =>
      validateOptions(
        parseArguments([
          "--serial",
          "ABC",
          "--package",
          "com.sentrapa.palmare.advanced"
        ])
      ),
    (error) =>
      error instanceof HarnessError &&
      error.code === "QR_SOURCE_REQUIRED"
  );
});

test("end-to-end dry run emits no QR token to stdout or stderr", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-dry-run-")
  );
  const qrPath = path.join(directory, "enrollment.json");
  const token = fixtureToken();
  try {
    fs.writeFileSync(qrPath, validQr(token), { mode: 0o600 });
    fs.chmodSync(qrPath, 0o600);
    const captured = await captureProcessOutput(() =>
      main([
        "--serial",
        "PALMARE_TEST_SERIAL",
        "--package",
        "com.sentrapa.palmare.advanced",
        "--qr-file",
        qrPath,
        "--dry-run"
      ])
    );
    assert.equal(captured.result, 0);
    assert.equal(captured.stdout.includes(token), false);
    assert.equal(captured.stderr.includes(token), false);
    const report = JSON.parse(captured.stdout);
    assert.equal(report.verdict, "DRY_RUN_PASS");
    assert.equal(report.qr.tokenIncluded, false);
    assert.equal(report.commandPlan.tokenInArguments, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("built-in self-test is offline and passes", () => {
  const report = runSelfTest();
  assert.equal(report.verdict, "SELF_TEST_PASS");
  assert.equal(report.physicalDeviceAccessed, false);
  assert.equal(report.activeV4Changes, false);
});

test("module import does not execute the CLI", async () => {
  const moduleUrl = new URL(
    "./run-b2-android-adb-harness.mjs?module-import-test",
    import.meta.url
  );
  const captured = await captureProcessOutput(() => import(moduleUrl.href));
  assert.equal(typeof captured.result.main, "function");
  assert.equal(captured.stdout, "");
  assert.equal(captured.stderr, "");
});
