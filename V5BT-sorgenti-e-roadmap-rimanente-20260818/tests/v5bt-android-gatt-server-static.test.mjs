import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  "APPLICATIVI/Palmare/android-app",
  "APPLICATIVI/Postazione/android-app",
];
const main = "app/src/main/java/com/sentrapa/webkiosk/bluetooth";
const unit = "app/src/test/java/com/sentrapa/webkiosk/bluetooth";

function read(appRoot, relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, appRoot, relativePath), "utf8");
}

test("GATT server implementation and tests remain shared byte for byte", () => {
  for (const relativePath of [
    `${main}/AndroidGattServer.kt`,
    `${main}/AndroidGattServerSessionHandlerV1.kt`,
    `${main}/AndroidGattServerSecurePromotionV1.kt`,
    `${main}/AndroidAndroidRoleElectionV1.kt`,
    `${main}/BluetoothGattServerLabReporter.kt`,
    `${main}/BluetoothFailoverFeaturePolicy.kt`,
    `${main}/BluetoothDiscoveryPolicy.kt`,
    `${main}/BluetoothDiscoveryCoordinator.kt`,
    `${unit}/AndroidGattServerSessionHandlerV1Test.kt`,
    `${unit}/AndroidGattServerSecurePromotionV1Test.kt`,
    `${unit}/AndroidAndroidRoleElectionV1Test.kt`,
    `${unit}/BluetoothGattServerLabReporterTest.kt`,
  ]) {
    assert.equal(read(roots[0], relativePath), read(roots[1], relativePath), relativePath);
  }
});

test("Android adapter publishes the frozen profile and owns lifecycle cleanup", () => {
  const source = read(roots[0], `${main}/AndroidGattServer.kt`);

  for (const marker of [
    "openGattServer",
    "addService(profile)",
    "onServiceAdded",
    "onConnectionStateChange",
    "onMtuChanged",
    "onCharacteristicReadRequest",
    "onCharacteristicWriteRequest",
    "onDescriptorReadRequest",
    "onDescriptorWriteRequest",
    "onNotificationSent",
    "AndroidGattProfileV1.clientConfigurationDescriptorUuid",
    "clearServices()",
    "activeServer.close()",
    "handler.reset()",
    "publishActive(false)",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.match(source, /state == AndroidGattServerState\.ACTIVE && servicePublished/);
  assert.match(source, /AndroidGattProfileV1\.characteristics\.forEach/);
  assert.doesNotMatch(source, /\.address\b|\.name\b|Log\.|println\(|print\(/);
});

test("public B6 boundary is opaque and later protocol gates stay denied", () => {
  const source = read(roots[0], `${main}/AndroidGattServerSessionHandlerV1.kt`);

  assert.match(source, /interface AndroidGattServerSessionHandlerV1/);
  for (const method of [
    "onConnected",
    "onMtuChanged",
    "onRead",
    "onWrite",
    "onSubscriptionChanged",
    "onDisconnected",
    "expire",
    "reset",
    "snapshot",
  ]) {
    assert.ok(source.includes(`fun ${method}`), method);
  }
  assert.match(
    source,
    /characteristicUuid != AndroidGattProfileV1\.helloUuid[\s\S]*denyAndRemove\(peerToken\)/,
  );
  assert.match(
    source,
    /onSubscriptionChanged[\s\S]*activeSession\(peerToken, nowElapsedMs\)[\s\S]*denyAndRemove\(peerToken\)/,
  );
  assert.match(source, /secureActiveSessionCount = 0/);
  assert.match(source, /securePromotionBlockedSessionCount =/);
  assert.doesNotMatch(source, /BluetoothDevice|BluetoothGatt|macAddress|androidId/i);
});

test("B6 Android role and secure promotion boundaries fail closed", () => {
  const role = read(roots[0], `${main}/AndroidAndroidRoleElectionV1.kt`);
  const promotion = read(roots[0], `${main}/AndroidGattServerSecurePromotionV1.kt`);

  assert.match(role, /localAlias < remoteAlias[\s\S]*AndroidAndroidGattRoleV1\.SERVER/);
  assert.match(role, /BluetoothNodeClass\.CLIENT_ONLY[\s\S]*CLIENT_ONLY_NOT_ELIGIBLE/);
  assert.match(role, /AndroidDirectNodePairKeyV1[\s\S]*MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(role, /compareUnsigned\(existingSession, candidateSession\)/);
  assert.match(promotion, /UnavailableAndroidGattServerPeerTrustPortV1/);
  assert.match(promotion, /PEER_TRUST_UNAVAILABLE/);
  assert.match(promotion, /MUTUAL_AUTHENTICATION_INCOMPLETE/);
  assert.match(promotion, /DIRECT_CONTROL_KEYS_UNAVAILABLE/);
  assert.match(promotion, /RELIABLE_CHANNEL_UNATTACHED/);
  assert.match(promotion, /DURABLE_STORE_UNATTACHED/);
  assert.match(
    promotion,
    /AndroidGattServerSecureSessionStateV1\.ACTIVE,[\s\S]*AndroidGattServerSecureBlockerV1\.NONE/,
  );
  assert.doesNotMatch(promotion, /secret|password|authenticationKey|privateKey/i);
});

test("server activation is flag-bound, real in reporters, and does not promote B9", () => {
  const service = read(roots[0], `${main}/BluetoothFailoverService.kt`);
  const policy = read(roots[0], `${main}/BluetoothFailoverFeaturePolicy.kt`);
  const discovery = read(roots[0], `${main}/BluetoothDiscoveryCoordinator.kt`);
  const advertisement = read(roots[0], `${main}/BluetoothDiscoveryPolicy.kt`);
  const reporter = read(roots[0], `${main}/BluetoothGattServerLabReporter.kt`);

  assert.match(policy, /gattServerEnabled = gattServerEnabled/);
  assert.match(policy, /futureSessionFlagsGuarded = agentEnabled && input\.peerLinkEnabled/);
  assert.match(service, /enabled = decision\.gattServerEnabled/);
  assert.match(service, /gattServerActive = serverSnapshot\?\.active == true/);
  assert.match(service, /sessionCount = serverSnapshot\?\.sessionCount \?: 0/);
  assert.match(discovery, /isAdvertisementConnectable\(gattServerActive\)/);
  assert.match(advertisement, /serverReachable = false/g);
  assert.doesNotMatch(advertisement, /serverReachable = true/);
  assert.match(reporter, /V5BT_ANDROID_GATT_SERVER_LAB/);
  assert.doesNotMatch(reporter, /macAddress|deviceId|androidId|rotatingAlias|peerToken/i);
});

test("API31 compatibility enables the server only in its explicit NON_GATE build", () => {
  const stationGradle = read(roots[1], "app/build.gradle.kts");
  const handheldGradle = read(roots[0], "app/build.gradle.kts");
  const api31Start = stationGradle.indexOf('create("api31Compat")');
  const api31End = stationGradle.indexOf("compileOptions", api31Start);
  const api31Block = stationGradle.slice(api31Start, api31End);

  assert.ok(api31Start >= 0 && api31End > api31Start);
  assert.match(api31Block, /"BLUETOOTH_DIRECT_SERVER_ENABLED"[\s\S]*\.forEach \{ field ->[\s\S]*"true"/);
  assert.match(api31Block, /listOf\("BLUETOOTH_PEER_LINK_ENABLED"\)[\s\S]*"false"/);
  const directServerDefault =
    /providers\.gradleProperty\("cassaBluetoothDirectServer"\)[\s\S]{0,160}\.getOrElse\(false\)/;
  assert.match(stationGradle, directServerDefault);
  assert.match(handheldGradle, directServerDefault);
});
