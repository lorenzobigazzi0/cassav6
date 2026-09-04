import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativeScanner =
  "app/src/main/java/com/sentrapa/webkiosk/bluetooth/BleScanner.kt";
const relativeTest =
  "app/src/test/java/com/sentrapa/webkiosk/bluetooth/BleScannerCompatibilityTest.kt";
const roots = [
  "APPLICATIVI/Palmare/android-app",
  "APPLICATIVI/Postazione/android-app",
];

function readFrom(appRoot, relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, appRoot, relativePath), "utf8");
}

test("Android 12 scan fallback implementation and unit coverage remain shared", () => {
  const scannerSources = roots.map((root) => readFrom(root, relativeScanner));
  const unitSources = roots.map((root) => readFrom(root, relativeTest));

  assert.equal(scannerSources[0], scannerSources[1]);
  assert.equal(unitSources[0], unitSources[1]);
});

test("fallback is non-gate, Android 12-only, bounded and software fail-closed", () => {
  const source = readFrom(roots[0], relativeScanner);

  assert.match(source, /API31_COMPAT_NON_GATE/);
  assert.match(source, /androidApi in 31\.\.32/);
  assert.match(source, /MAX_SOFTWARE_INSPECTIONS_PER_SCAN = 4_096/);
  assert.match(source, /MAX_SOFTWARE_MATCHES_PER_SCAN\s*=\s*\n\s*BluetoothDiscoveryPolicy\.MAX_PENDING_SCAN_RESULTS/);
  assert.match(source, /payload\.size != BluetoothAdvertisementCodecV1\.PAYLOAD_BYTES/);
  assert.match(source, /header and 0x07 != BluetoothAdvertisementCodecV1\.PROTOCOL_VERSION/);
  assert.match(source, /UNFILTERED_ANDROID_12_NON_GATE ->\s*\n\s*emptyList\(\)/);
  assert.match(source, /SERVICE_DATA_V1 ->\s*\n\s*listOf\(/);
});

test("fallback copies only matched service data and never reads or logs device identifiers", () => {
  const source = readFrom(roots[0], relativeScanner);
  const matchIndex = source.indexOf("BluetoothAdvertisementScanMatcherV1.matches(payload)");
  const copyIndex = source.indexOf("payload.copyOf()");

  assert.ok(matchIndex >= 0);
  assert.ok(copyIndex > matchIndex);
  assert.doesNotMatch(source, /\.address\b|\.name\b|Log\.|println\(|print\(/);
  assert.doesNotMatch(source, /macAddress|deviceId|androidId/i);
});

test("redacted diagnostics separate raw callbacks, UUID matches and valid payloads", () => {
  const scanner = readFrom(roots[0], relativeScanner);
  const coordinator = readFrom(
    roots[0],
    "app/src/main/java/com/sentrapa/webkiosk/bluetooth/BluetoothDiscoveryCoordinator.kt",
  );
  const reporter = readFrom(
    roots[0],
    "app/src/main/java/com/sentrapa/webkiosk/bluetooth/BluetoothDiscoveryLabReporter.kt",
  );

  const rawIndex = scanner.indexOf(
    "notifyDiagnostic(BluetoothScanDiagnosticEvent.RAW_CALLBACK",
  );
  const serviceDataIndex = scanner.indexOf("getServiceData(serviceUuid)");
  const uuidIndex = scanner.indexOf(
    "notifyDiagnostic(BluetoothScanDiagnosticEvent.UUID_MATCH",
  );
  assert.ok(rawIndex >= 0 && rawIndex < serviceDataIndex);
  assert.ok(serviceDataIndex < uuidIndex);
  assert.match(
    coordinator,
    /BluetoothAdvertisementCodecV1\.decode\(result\.payload\)[\s\S]*metrics\.recordValidPayload\(\)/,
  );
  for (const field of ["rawCallbacks", "uuidMatches", "validPayloads"]) {
    assert.ok(reporter.includes(`append("\\"${field}\\":")`));
  }
  assert.doesNotMatch(reporter, /macAddress|deviceId|androidId|rotatingAlias/i);
});
