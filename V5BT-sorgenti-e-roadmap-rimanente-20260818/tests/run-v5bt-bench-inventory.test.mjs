import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";
import {
  assertReadOnlyCommand,
  consumePasswordEnvironmentVariable,
  createExecCommandRunner,
  createFixtureCommandRunner,
  parseBenchInventoryConfig,
  runBenchInventory,
  writeBenchInventoryOutputs,
} from "../scripts/run-v5bt-bench-inventory.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixedNow = new Date("2026-08-03T10:00:00.000Z");
const privateSecrets = Object.freeze({
  host: "bench-private.example.test",
  handheldSerial: "10.20.30.41:5555",
  stationSerial: "10.20.30.42:5555",
  sessionToken: "session-token-private-value",
  deviceUuid: "11111111-2222-4333-8444-555555555555",
  registryNode: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  stationRegistryNode: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  stationDeviceUuid: "22222222-3333-4444-8555-666666666666",
  controllerAddress: "AA:BB:CC:DD:EE:FF",
  upsName: "ups-private-name@localhost",
});

function result(stdout = "", exitCode = 0, stderr = "") {
  return { exitCode, stdout, stderr, timedOut: false };
}

function inventoryConfig() {
  return {
    schemaVersion: 1,
    raspberryHost: privateSecrets.host,
    raspberryUser: "admin",
    sshPort: 22,
    android: [
      { label: "palmare_test", role: "handheld", serial: privateSecrets.handheldSerial, expectedUserId: 0 },
      { label: "postazione_test", role: "station", serial: privateSecrets.stationSerial, expectedUserId: 0 },
    ],
  };
}

function packageDump(target) {
  return `
Packages:
  Package [${target.packageId}]
    versionCode=${target.versionCode} minSdk=24 targetSdk=34
    versionName=${target.versionName}
    User 0: installed=true hidden=false suspended=false stopped=false enabled=0
    runtime permissions:
      android.permission.BLUETOOTH_SCAN: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED ]
      android.permission.BLUETOOTH_CONNECT: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED ]
      android.permission.BLUETOOTH_ADVERTISE: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED ]
`;
}

function serviceOutput({
  loadState = "loaded",
  activeState = "active",
  subState = "running",
  unitFileState = "enabled",
} = {}) {
  return `LoadState=${loadState}\nActiveState=${activeState}\nSubState=${subState}\nUnitFileState=${unitFileState}\n`;
}

function completeFixtureResults() {
  const targets = ADVANCED_CERTIFICATION_TARGETS.roles;
  const results = {
    "adb.devices": result(
      `List of devices attached\n${privateSecrets.handheldSerial}\tdevice product:test model:PrivateHandheld\n${privateSecrets.stationSerial}\tdevice product:test model:PrivateStation\n`,
    ),
    "raspberry.identity": result("aarch64\n"),
    "raspberry.bluez.version": result("bluetoothctl: 5.79\n"),
    "raspberry.bluez.show": result(`Controller ${privateSecrets.controllerAddress} (public)\n\tPowered: yes\n\tDiscovering: no\n`),
    "raspberry.ntp": result("NTPSynchronized=yes\nTimeUSec=Sun 2026-08-03 12:00:00 CEST\nTimezone=Europe/Rome\n"),
    "raspberry.ups.discovery": result(`${privateSecrets.upsName}\n`),
    "raspberry.ups.services": result("nut-monitor.service loaded active running Network UPS Tools\n"),
    "raspberry.state.stat": result("700,cassav5bt,cassav5bt,4096,directory\n"),
    "raspberry.registry.stat": result("600,cassav5bt,cassav5bt,2048,regular file\n"),
    "raspberry.registry.read": result(`${JSON.stringify({
      schemaVersion: 1,
      devices: [
        { nodeId: privateSecrets.registryNode, revokedAt: null },
        { nodeId: privateSecrets.stationRegistryNode, revokedAt: null },
      ],
      enrollmentTokens: [{ consumedAt: null, expiresAt: "2026-09-03T10:00:00.000Z", tokenHashBase64: "private-token-hash" }],
    })}\n`),
    "raspberry.transactions.stat": result("700,cassav5bt,cassav5bt,4096,directory\n"),
    "raspberry.transactions.list": result("f,0600,cassav5bt,cassav5bt,/var/lib/cassav5bt-bluetooth/enrollment-transactions/private.json\n"),
    "raspberry.tlsKey.stat": result("600,cassav5bt,cassav5bt,1704,regular file\n"),
    "raspberry.tlsCert.stat": result("644,cassav5bt,cassav5bt,1517,regular file\n"),
    "raspberry.environment.stat": result("600,root,root,512,regular file\n"),
  };
  for (const service of [
    "cassav5bt.service",
    "bluetooth.service",
    "cassav5bt-bluetooth-node.service",
    "cassav5bt-bluetooth-enrollment.service",
  ]) {
    results[`raspberry.service.${service}`] = result(serviceOutput());
  }
  for (const [index, role] of ["handheld", "station"].entries()) {
    const target = targets[role];
    const apkPath = `/data/app/~~private/${target.packageId}-private/base.apk`;
    const deviceUuid = index === 0 ? privateSecrets.deviceUuid : privateSecrets.stationDeviceUuid;
    const registryNode = index === 0 ? privateSecrets.registryNode : privateSecrets.stationRegistryNode;
    results[`android.${index}.user`] = result("0\n");
    results[`android.${index}.api`] = result("34\n");
    results[`android.${index}.package`] = result(packageDump(target));
    results[`android.${index}.apkPath`] = result(`package:${apkPath}\n`);
    results[`android.${index}.apkSha256`] = result(`${target.sha256}  ${apkPath}\n`);
    results[`android.${index}.session`] = result(
      `<map><string name="notification_token">${privateSecrets.sessionToken}-${index}</string><string name="notification_user_id">42</string><string name="notification_device_uuid">${deviceUuid}</string></map>\n`,
    );
    results[`android.${index}.identity`] = result(
      `<map><string name="enrollment_state">READY</string><string name="enrollment_node_id">${registryNode}</string><string name="enrollment_certificate_id">${deviceUuid}</string></map>\n`,
    );
    results[`android.${index}.enrollmentStatus`] = result('{"version":1,"status":"READY","identityStatus":"READY"}\n');
  }
  return results;
}

test("fixture inventory is complete while the exportable summary excludes private identifiers", async () => {
  const config = parseBenchInventoryConfig(inventoryConfig());
  const runner = createFixtureCommandRunner(completeFixtureResults());
  const output = await runBenchInventory(config, { runner, clock: () => new Date(fixedNow) });

  assert.equal(output.summary.status, "COMPLETE");
  assert.equal(
    output.summary.certificationMatrixSha256,
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
  );
  assert.equal(
    output.privateReport.certificationMatrixSha256,
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
  );
  assert.equal(output.summary.readOnly, true);
  assert.deepEqual(output.summary.roleCoverage, {
    requiredRoles: ["handheld", "station"],
    configuredRoles: ["handheld", "station"],
    missingRequiredRoles: [],
    complete: true,
  });
  assert.equal(output.summary.commandPolicy.sshAuthentication, "PUBLIC_KEY");
  assert.deepEqual(output.summary.commandPolicy, output.privateReport.commandPolicy);
  assert.deepEqual(output.summary.limitations, []);
  assert.equal(output.summary.raspberry.ups.discoveryOnly, true);
  assert.equal(output.summary.raspberry.ups.discoveredDevices, 1);
  assert.equal(output.summary.raspberry.permissionsSecure, true);
  assert.equal(output.summary.raspberry.registry.activeDevices, 2);
  assert.equal(output.summary.android.length, 2);
  assert.ok(output.summary.android.every((entry) => entry.apkSha256Matches && entry.enrollmentReady));
  assert.ok(output.summary.android.every((entry) =>
    entry.signingCertificatePinCoveredByCertifiedApk &&
    entry.expectedSigningCertificateSha256 ===
      ADVANCED_CERTIFICATION_TARGETS.roles[entry.role].signingCertificateSha256
  ));
  assert.ok(output.privateReport.config.android.every((entry) =>
    entry.expectedSigningCertificateSha256 ===
      ADVANCED_CERTIFICATION_TARGETS.roles[entry.role].signingCertificateSha256
  ));
  assert.ok(output.summary.android.every((entry) => entry.packageInstalled && entry.packageStopped === false));
  assert.deepEqual(
    output.summary.raspberry.services.map(({ service, requirement, expectedState, observed, expectationMet }) => ({
      service,
      requirement,
      expectedState,
      observed,
      expectationMet,
    })),
    [
      { service: "cassav5bt.service", requirement: "OPERATIONAL_REQUIRED", expectedState: "LOADED_ACTIVE_ENABLED", observed: true, expectationMet: true },
      { service: "bluetooth.service", requirement: "OPERATIONAL_REQUIRED", expectedState: "LOADED_ACTIVE_ENABLED", observed: true, expectationMet: true },
      { service: "cassav5bt-bluetooth-node.service", requirement: "OBSERVE_ONLY", expectedState: "ANY_OBSERVED_STATE", observed: true, expectationMet: true },
      { service: "cassav5bt-bluetooth-enrollment.service", requirement: "OBSERVE_ONLY", expectedState: "ANY_OBSERVED_STATE", observed: true, expectationMet: true },
    ],
  );

  const redacted = JSON.stringify(output.summary);
  for (const secret of Object.values(privateSecrets)) assert.equal(redacted.includes(secret), false, secret);
  assert.equal(redacted.includes("private-token-hash"), false);
  assert.equal(redacted.includes("/var/lib/cassav5bt-bluetooth/enrollment-transactions/private.json"), false);

  const privateJson = JSON.stringify(output.privateReport);
  assert.match(privateJson, new RegExp(privateSecrets.host.replaceAll(".", "\\.")));
  assert.match(privateJson, new RegExp(privateSecrets.handheldSerial.replaceAll(".", "\\.")));
  assert.match(privateJson, /session-token-private-value/);
  for (const probe of output.privateReport.probes) assert.equal(assertReadOnlyCommand({ ...probe.command, id: probe.id, transport: probe.transport }), true);
  assert.equal(output.privateReport.probes.filter((probe) => probe.id === "raspberry.ups.discovery").length, 1);
  assert.equal(output.privateReport.probes.some((probe) => probe.command.args.some((argument) => /upsc\s+ups-private/iu.test(argument))), false);
});

test("an inventory with only handheld targets cannot become COMPLETE", async () => {
  const rawConfig = inventoryConfig();
  rawConfig.android[1].role = "handheld";
  const fixture = completeFixtureResults();
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
  const apkPath = `/data/app/~~private/${target.packageId}-private/base.apk`;
  fixture["android.1.package"] = result(packageDump(target));
  fixture["android.1.apkPath"] = result(`package:${apkPath}\n`);
  fixture["android.1.apkSha256"] = result(`${target.sha256}  ${apkPath}\n`);

  const output = await runBenchInventory(parseBenchInventoryConfig(rawConfig), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "INCOMPLETE");
  assert.deepEqual(output.summary.roleCoverage, {
    requiredRoles: ["handheld", "station"],
    configuredRoles: ["handheld"],
    missingRequiredRoles: ["station"],
    complete: false,
  });
  assert.equal(
    output.summary.errors.some(
      (entry) =>
        entry.probe === "android.roleCoverage" &&
        entry.code === "REQUIRED_ROLE_MISSING",
    ),
    true,
  );
  assert.equal(
    output.summary.android.every(
      (entry) =>
        entry.versionNameMatches &&
        entry.versionCodeMatches &&
        entry.apkSha256Matches,
    ),
    true,
  );
});

test("an installed APK digest mismatch also breaks signing certificate pin coverage", async () => {
  const fixture = completeFixtureResults();
  fixture["android.0.apkSha256"] = result(
    `${"f".repeat(64)}  /data/app/~~private/changed/base.apk\n`,
  );
  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "INCOMPLETE");
  assert.equal(output.summary.android[0].apkSha256Matches, false);
  assert.equal(
    output.summary.android[0].signingCertificatePinCoveredByCertifiedApk,
    false,
  );
  assert.equal(
    output.summary.android[1].signingCertificatePinCoveredByCertifiedApk,
    true,
  );
});

test("observe-only Lab services may be off while unavailable UPS discovery is nonblocking", async () => {
  const fixture = completeFixtureResults();
  fixture["raspberry.service.cassav5bt-bluetooth-node.service"] = result(serviceOutput({
    loadState: "not-found",
    activeState: "inactive",
    subState: "dead",
    unitFileState: "",
  }));
  fixture["raspberry.service.cassav5bt-bluetooth-enrollment.service"] = result(serviceOutput({
    activeState: "inactive",
    subState: "dead",
    unitFileState: "disabled",
  }));
  fixture["raspberry.ups.discovery"] = result("", 127, "upsc is unavailable");

  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "COMPLETE");
  assert.deepEqual(output.summary.errors, []);
  assert.deepEqual(output.summary.limitations, [{ code: "UPS_DISCOVERY_UNAVAILABLE" }]);
  assert.equal(output.summary.raspberry.ups.probeAvailable, false);
  const [main, bluetooth, node, enrollment] = output.summary.raspberry.services;
  assert.ok(main.expectationMet && bluetooth.expectationMet);
  assert.deepEqual(
    { requirement: node.requirement, observed: node.observed, expectationMet: node.expectationMet, loaded: node.loaded, active: node.active, enabled: node.enabled },
    { requirement: "OBSERVE_ONLY", observed: true, expectationMet: true, loaded: false, active: false, enabled: false },
  );
  assert.deepEqual(
    { requirement: enrollment.requirement, observed: enrollment.observed, expectationMet: enrollment.expectationMet, loaded: enrollment.loaded, active: enrollment.active, enabled: enrollment.enabled },
    { requirement: "OBSERVE_ONLY", observed: true, expectationMet: true, loaded: true, active: false, enabled: false },
  );
});

test("an inactive operational service keeps the inventory incomplete", async () => {
  const fixture = completeFixtureResults();
  fixture["raspberry.service.cassav5bt.service"] = result(serviceOutput({
    activeState: "inactive",
    subState: "dead",
  }));

  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "INCOMPLETE");
  assert.deepEqual(output.summary.errors, []);
  const service = output.summary.raspberry.services.find((entry) => entry.service === "cassav5bt.service");
  assert.deepEqual(
    { requirement: service.requirement, expectedState: service.expectedState, observed: service.observed, expectationMet: service.expectationMet },
    { requirement: "OPERATIONAL_REQUIRED", expectedState: "LOADED_ACTIVE_ENABLED", observed: true, expectationMet: false },
  );
});

test("empty UPS discovery is a stable nonblocking limitation", async () => {
  const fixture = completeFixtureResults();
  fixture["raspberry.ups.discovery"] = result("");

  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "COMPLETE");
  assert.deepEqual(output.summary.errors, []);
  assert.deepEqual(output.summary.limitations, [{ code: "UPS_NO_DEVICES_DISCOVERED" }]);
  assert.deepEqual(output.summary.raspberry.ups, {
    discoveryOnly: true,
    probeAvailable: true,
    discoveredDevices: 0,
    serviceProbeAvailable: true,
    serviceUnitsObserved: 1,
  });
});

test("redacted UPS limitations never export captured secrets", async () => {
  const fixture = completeFixtureResults();
  const secret = "ups-command-private-secret";
  fixture["raspberry.ups.discovery"] = result(secret, 127, secret);
  fixture["raspberry.ups.services"] = result(secret, 1, secret);

  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "COMPLETE");
  assert.deepEqual(output.summary.limitations, [
    { code: "UPS_DISCOVERY_UNAVAILABLE" },
    { code: "UPS_SERVICE_DISCOVERY_UNAVAILABLE" },
  ]);
  assert.equal(JSON.stringify(output.privateReport).includes(secret), true);
  const redacted = JSON.stringify(output.summary);
  assert.equal(redacted.includes(secret), false);
  for (const privateValue of Object.values(privateSecrets)) {
    assert.equal(redacted.includes(privateValue), false, privateValue);
  }
});

test("a non-UPS probe failure remains blocking", async () => {
  const fixture = completeFixtureResults();
  fixture["android.0.enrollmentStatus"] = result("", 1, "private enrollment probe failure");

  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.status, "INCOMPLETE");
  assert.deepEqual(output.summary.limitations, []);
  assert.deepEqual(output.summary.errors, [
    { probe: "android.0.enrollmentStatus", code: "UNAVAILABLE" },
  ]);
  assert.equal(JSON.stringify(output.summary).includes("private enrollment probe failure"), false);
});

test("a stopped package remains installed but is not bench-ready", async () => {
  const fixture = completeFixtureResults();
  fixture["android.0.package"] = result(
    fixture["android.0.package"].stdout.replace("stopped=false", "stopped=true"),
  );
  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(fixture),
    clock: () => new Date(fixedNow),
  });

  assert.equal(output.summary.android[0].packageInstalled, true);
  assert.equal(output.summary.android[0].packageStopped, true);
  assert.equal(output.summary.android[1].packageInstalled, true);
  assert.equal(output.summary.android[1].packageStopped, false);
  assert.equal(output.summary.status, "INCOMPLETE");
});

test("package installation and an unknown stopped state fail independently", async () => {
  const notInstalledFixture = completeFixtureResults();
  notInstalledFixture["android.0.package"] = result(
    notInstalledFixture["android.0.package"].stdout.replace("installed=true", "installed=false"),
  );
  const notInstalled = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(notInstalledFixture),
    clock: () => new Date(fixedNow),
  });
  assert.equal(notInstalled.summary.android[0].packageInstalled, false);
  assert.equal(notInstalled.summary.android[0].packageStopped, null);
  assert.equal(notInstalled.summary.status, "INCOMPLETE");

  const unknownStateFixture = completeFixtureResults();
  unknownStateFixture["android.0.package"] = result(
    unknownStateFixture["android.0.package"].stdout.replace(" stopped=false", ""),
  );
  const unknownState = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(unknownStateFixture),
    clock: () => new Date(fixedNow),
  });
  assert.equal(unknownState.summary.android[0].packageInstalled, true);
  assert.equal(unknownState.summary.android[0].packageStopped, null);
  assert.equal(unknownState.summary.status, "INCOMPLETE");
});

test("the command policy rejects mutating ADB and SSH commands", () => {
  assert.equal(assertReadOnlyCommand({ id: "adb.devices", transport: "ADB", executable: "adb", args: ["devices", "-l"] }), true);
  assert.throws(
    () => assertReadOnlyCommand({ id: "adb.install", transport: "ADB", executable: "adb", args: ["install", "application.apk"] }),
    /allowlist/i,
  );
  assert.throws(
    () => assertReadOnlyCommand({
      id: "adb.pathEscape",
      transport: "ADB",
      executable: "adb",
      args: ["-s", "serial", "exec-out", "sha256sum", "/data/app/../../private/base.apk"],
    }),
    /allowlist/i,
  );
  assert.throws(
    () => assertReadOnlyCommand({
      id: "raspberry.restart",
      transport: "SSH",
      executable: "ssh",
      args: [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "LogLevel=ERROR",
        "-p", "22", "admin@bench.example.test", "--", "/usr/bin/systemctl restart cassav5bt.service",
      ],
    }),
    /allowlist/i,
  );
  assert.equal(assertReadOnlyCommand({
    id: "raspberry.registry.read",
    transport: "SSH",
    executable: "ssh",
    args: [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "LogLevel=ERROR",
      "-p", "22", "admin@bench.example.test", "--",
      "/usr/bin/sudo -S -p '' -- /usr/bin/cat -- /var/lib/cassav5bt-bluetooth/devices.json",
    ],
  }), true);
  assert.throws(
    () => assertReadOnlyCommand({
      id: "raspberry.sudoRestart",
      transport: "SSH",
      executable: "ssh",
      args: [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "LogLevel=ERROR",
        "-p", "22", "admin@bench.example.test", "--",
        "/usr/bin/sudo -S -p '' -- /usr/bin/systemctl restart cassav5bt.service",
      ],
    }),
    /allowlist/i,
  );
  assert.equal(assertReadOnlyCommand({
    id: "raspberry.password.identity",
    transport: "SSH",
    executable: "ssh",
    args: [
      "-o", "BatchMode=no",
      "-o", "PreferredAuthentications=password",
      "-o", "PasswordAuthentication=yes",
      "-o", "PubkeyAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "NumberOfPasswordPrompts=1",
      "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "LogLevel=ERROR",
      "-p", "22", "admin@bench.example.test", "--", "/usr/bin/uname -m",
    ],
  }), true);
  assert.throws(
    () => assertReadOnlyCommand({
      id: "raspberry.password.incomplete",
      transport: "SSH",
      executable: "ssh",
      args: [
        "-o", "BatchMode=no", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "LogLevel=ERROR",
        "-p", "22", "admin@bench.example.test", "--", "/usr/bin/uname -m",
      ],
    }),
    /canonical/i,
  );
});

test("SSH password auth uses sshpass env while sudo remains a separate stdin secret", async (t) => {
  const capturedSpecs = [];
  await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    sshAuthentication: "PASSWORD",
    raspberrySudo: true,
    clock: () => new Date(fixedNow),
    runner: async (spec) => {
      capturedSpecs.push(spec);
      return spec.id === "adb.devices"
        ? result("List of devices attached\n")
        : result("", 255, "offline fixture");
    },
  });
  const sshSpec = capturedSpecs.find((spec) => spec.id === "raspberry.identity");
  assert.ok(sshSpec);
  assert.ok(sshSpec.args.includes("BatchMode=no"));
  assert.ok(sshSpec.args.includes("PreferredAuthentications=password"));
  assert.equal(sshSpec.args.includes("BatchMode=yes"), false);

  const sshSecret = "ssh-password-private-value";
  const sudoSecret = "sudo-password-private-value";
  let invocation = null;
  let sudoInput = null;
  const execFileImpl = (executable, args, options, callback) => {
    invocation = { executable, args: [...args], options };
    queueMicrotask(() => callback(null, "aarch64\n", ""));
    return {
      stdin: {
        end(value, encoding) {
          sudoInput = { value, encoding };
        },
      },
    };
  };
  const runner = createExecCommandRunner({ sshPassword: sshSecret, sudoPassword: sudoSecret, execFileImpl });
  const execution = await runner(sshSpec);
  assert.equal(execution.exitCode, 0);
  assert.equal(invocation.executable, "sshpass");
  assert.deepEqual(invocation.args.slice(0, 2), ["-e", "ssh"]);
  assert.deepEqual(invocation.args.slice(2), sshSpec.args);
  assert.equal(invocation.options.env.SSHPASS, sshSecret);
  assert.deepEqual(sudoInput, { value: `${sudoSecret}\n`, encoding: "utf8" });
  assert.equal(JSON.stringify({ command: sshSpec, executable: invocation.executable, args: invocation.args, execution }).includes(sshSecret), false);
  assert.equal(JSON.stringify({ command: sshSpec, executable: invocation.executable, args: invocation.args, execution }).includes(sudoSecret), false);

  let publicKeySpawned = false;
  const publicKeySpec = {
    id: "raspberry.publicKey.identity",
    transport: "SSH",
    executable: "ssh",
    args: [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "LogLevel=ERROR",
      "-p", "22", "admin@bench.example.test", "--", "/usr/bin/uname -m",
    ],
  };
  await assert.rejects(
    createExecCommandRunner({
      sshPassword: sshSecret,
      execFileImpl() {
        publicKeySpawned = true;
      },
    })(publicKeySpec),
    (error) => error?.code === "SSH_AUTH_SPEC_MISMATCH",
  );
  assert.equal(publicKeySpawned, false);
  t.diagnostic("no live SSH or ADB transport was invoked");
});

test("password environment input is consumed immediately and is absent from attestations", async (t) => {
  const environmentName = "V5BT_TEST_SSH_PASSWORD";
  const secret = "environment-password-private-value";
  process.env[environmentName] = secret;
  t.after(() => { delete process.env[environmentName]; });
  assert.equal(consumePasswordEnvironmentVariable(environmentName, "SSH"), secret);
  assert.equal(Object.hasOwn(process.env, environmentName), false);

  const output = await runBenchInventory(parseBenchInventoryConfig(inventoryConfig()), {
    runner: createFixtureCommandRunner(completeFixtureResults()),
    sshAuthentication: "PASSWORD",
    clock: () => new Date(fixedNow),
  });
  assert.equal(output.privateReport.commandPolicy.sshAuthentication, "PASSWORD");
  assert.equal(output.summary.commandPolicy.sshAuthentication, "PASSWORD");
  assert.deepEqual(output.summary.commandPolicy, output.privateReport.commandPolicy);
  const attestations = JSON.stringify(output);
  assert.equal(attestations.includes(secret), false);
  assert.equal(attestations.includes(environmentName), false);
});

test("unavailable devices produce a redacted incomplete inventory without fallback commands", async () => {
  const config = parseBenchInventoryConfig(inventoryConfig());
  const runner = createFixtureCommandRunner({
    "adb.devices": result(`List of devices attached\n${privateSecrets.handheldSerial}\tunauthorized\n`),
    "raspberry.identity": result("", 255, "private ssh failure"),
  });
  const output = await runBenchInventory(config, { runner, clock: () => new Date(fixedNow) });
  assert.equal(output.summary.status, "INCOMPLETE");
  assert.equal(output.summary.raspberry.reachable, false);
  assert.ok(output.summary.android.every((entry) => entry.connected === false));
  assert.deepEqual(output.privateReport.probes.map((probe) => probe.id), ["adb.devices", "raspberry.identity"]);
  assert.equal(JSON.stringify(output.summary).includes("private ssh failure"), false);
});

test("private and redacted outputs use fixed permissions and cannot be overwritten", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-bench-inventory-output-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = parseBenchInventoryConfig(inventoryConfig());
  const output = await runBenchInventory(config, {
    runner: createFixtureCommandRunner(completeFixtureResults()),
    clock: () => new Date(fixedNow),
  });
  const privatePath = path.join(directory, "private.json");
  const summaryPath = path.join(directory, "summary.json");
  writeBenchInventoryOutputs(output, privatePath, summaryPath);
  assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(summaryPath).mode & 0o777, 0o644);
  assert.equal(JSON.parse(fs.readFileSync(summaryPath, "utf8")).status, "COMPLETE");
  assert.throws(() => writeBenchInventoryOutputs(output, privatePath, summaryPath), /exist|EEXIST/i);
});

test("fixture CLI writes both reports without invoking live transports", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-bench-inventory-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, "fixture.json");
  const privatePath = path.join(directory, "private.json");
  const summaryPath = path.join(directory, "summary.json");
  fs.writeFileSync(fixturePath, `${JSON.stringify({
    schemaVersion: 1,
    config: inventoryConfig(),
    results: completeFixtureResults(),
  })}\n`, { mode: 0o600 });

  const help = spawnSync(process.execPath, [
    path.join(workspaceRoot, "scripts/run-v5bt-bench-inventory.mjs"),
    "--help",
  ], { encoding: "utf8", cwd: workspaceRoot });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--raspberry-ssh-password-env ENV_NAME/u);

  const cliSecret = "fixture-must-not-read-this-secret";
  const rejected = spawnSync(process.execPath, [
    path.join(workspaceRoot, "scripts/run-v5bt-bench-inventory.mjs"),
    "--fixture", fixturePath,
    "--raspberry-ssh-password-env", "V5BT_FIXTURE_SSH_PASSWORD",
    "--private-output", path.join(directory, "rejected-private.json"),
    "--summary-output", path.join(directory, "rejected-summary.json"),
  ], {
    encoding: "utf8",
    cwd: workspaceRoot,
    env: { ...process.env, V5BT_FIXTURE_SSH_PASSWORD: cliSecret },
  });
  assert.equal(rejected.status, 2, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /fixture mode does not accept live targets or password authentication/iu);
  assert.equal(`${rejected.stdout}${rejected.stderr}`.includes(cliSecret), false);

  const execution = spawnSync(process.execPath, [
    path.join(workspaceRoot, "scripts/run-v5bt-bench-inventory.mjs"),
    "--fixture", fixturePath,
    "--private-output", privatePath,
    "--summary-output", summaryPath,
  ], { encoding: "utf8", cwd: workspaceRoot });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.equal(JSON.parse(fs.readFileSync(summaryPath, "utf8")).status, "COMPLETE");
  assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(summaryPath).mode & 0o777, 0o644);
});
