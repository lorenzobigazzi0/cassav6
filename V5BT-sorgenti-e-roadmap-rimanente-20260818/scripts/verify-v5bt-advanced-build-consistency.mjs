#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadAdvancedCertificationTargets } from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MATRIX_RELATIVE = "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/configs/advanced-certification-targets.json";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_APKSIGNER_OUTPUT_BYTES = 1024 * 1024;
const APKSIGNER_TIMEOUT_MS = 30_000;
const ALLOWED_MAIN_DIFFERENCES = Object.freeze(["BluetoothFailoverService.kt"]);
const ROLES = Object.freeze({
  handheld: Object.freeze({
    appRoot: "APPLICATIVI/Palmare/android-app/app",
    expectedNodeKind: "handheld",
  }),
  station: Object.freeze({
    appRoot: "APPLICATIVI/Postazione/android-app/app",
    expectedNodeKind: "station",
  }),
});

export class BuildConsistencyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BuildConsistencyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BuildConsistencyError(code, message);
}

function regularFile(filePath, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch {
    fail("FILE_UNAVAILABLE", `${label} is unavailable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("FILE_INVALID", `${label} must be a regular file`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    fail("FILE_INVALID", `${label} has an invalid size`);
  }
  return metadata;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function openStableRegularFile(filePath, label, maximumBytes) {
  const before = regularFile(filePath, label, maximumBytes);
  if (before.size > maximumBytes) fail("FILE_INVALID", `${label} has an invalid size`);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    fail("FILE_INVALID", `${label} cannot be opened without following symlinks`);
  }
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
    fs.closeSync(descriptor);
    fail("FILE_CHANGED", `${label} changed while being opened`);
  }
  return { before, descriptor };
}

function closeStableRegularFile(filePath, label, before, descriptor) {
  const afterDescriptor = fs.fstatSync(descriptor);
  fs.closeSync(descriptor);
  const afterPath = fs.lstatSync(filePath);
  if (!sameFileSnapshot(before, afterDescriptor) || !sameFileSnapshot(before, afterPath)) {
    fail("FILE_CHANGED", `${label} changed while being read`);
  }
}

function readBuffer(filePath, label, maximumBytes = MAX_TEXT_BYTES) {
  const { before, descriptor } = openStableRegularFile(filePath, label, maximumBytes);
  const output = Buffer.allocUnsafe(before.size);
  let offset = 0;
  try {
    while (offset < output.length) {
      const bytes = fs.readSync(descriptor, output, offset, output.length - offset, null);
      if (bytes === 0) fail("FILE_CHANGED", `${label} ended while being read`);
      offset += bytes;
    }
    closeStableRegularFile(filePath, label, before, descriptor);
  } catch (error) {
    try { fs.closeSync(descriptor); } catch {}
    throw error;
  }
  return output;
}

function readText(filePath, label) {
  return readBuffer(filePath, label).toString("utf8");
}

function executableRegularFile(filePath, label) {
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch {
    fail("APKSIGNER_UNAVAILABLE", `${label} is unavailable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    fail("APKSIGNER_INVALID", `${label} must be an executable regular file`);
  }
  return filePath;
}

function sdkDirectoryFromLocalProperties(root) {
  const candidates = Object.values(ROLES).map((config) =>
    path.join(root, path.dirname(config.appRoot), "local.properties")
  );
  const sdkDirectories = new Set();
  for (const candidate of candidates) {
    let source;
    try {
      source = readText(candidate, "Android local.properties");
    } catch (error) {
      if (error instanceof BuildConsistencyError && error.code === "FILE_UNAVAILABLE") {
        continue;
      }
      throw error;
    }
    const matches = [...source.matchAll(/^sdk\.dir=(.+)$/gmu)];
    if (matches.length !== 1 || /[\0\r\n]/u.test(matches[0][1])) {
      fail("APKSIGNER_UNAVAILABLE", "Android SDK path is invalid");
    }
    const rawSdkDirectory = matches[0][1].replaceAll("\\\\", "\\");
    if (!path.isAbsolute(rawSdkDirectory)) {
      fail("APKSIGNER_UNAVAILABLE", "Android SDK path must be absolute");
    }
    const sdkDirectory = path.normalize(rawSdkDirectory);
    sdkDirectories.add(sdkDirectory);
  }
  if (sdkDirectories.size !== 1) {
    fail("APKSIGNER_UNAVAILABLE", "Android apps must resolve one shared SDK path");
  }
  return [...sdkDirectories][0];
}

export function resolveApksignerPath(root, explicitPath = null) {
  if (explicitPath !== null) {
    if (typeof explicitPath !== "string" || !path.isAbsolute(explicitPath)) {
      fail("APKSIGNER_INVALID", "explicit apksigner path must be absolute");
    }
    return executableRegularFile(path.normalize(explicitPath), "apksigner");
  }
  const sdkDirectory = sdkDirectoryFromLocalProperties(root);
  const buildToolsDirectory = path.join(sdkDirectory, "build-tools");
  let versions;
  try {
    const metadata = fs.lstatSync(buildToolsDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error();
    versions = fs.readdirSync(buildToolsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9._-]+)?$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
  } catch {
    fail("APKSIGNER_UNAVAILABLE", "Android SDK build-tools are unavailable");
  }
  for (const version of versions) {
    const candidate = path.join(buildToolsDirectory, version, "apksigner");
    try {
      return executableRegularFile(candidate, "apksigner");
    } catch (error) {
      if (!(error instanceof BuildConsistencyError) || error.code === "APKSIGNER_INVALID") {
        throw error;
      }
    }
  }
  fail("APKSIGNER_UNAVAILABLE", "apksigner is unavailable in Android SDK build-tools");
}

export function parseApksignerCertificateSha256(output) {
  if (typeof output !== "string" || output.length === 0 || output.length > MAX_APKSIGNER_OUTPUT_BYTES) {
    fail("APK_SIGNING_CERTIFICATE_INVALID", "apksigner certificate output is invalid");
  }
  const matches = [...output.matchAll(
    /^Signer #[1-9][0-9]* certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$/gmu
  )];
  if (matches.length !== 1) {
    fail("APK_SIGNING_CERTIFICATE_INVALID", "APK must expose exactly one signing certificate");
  }
  return matches[0][1].toLowerCase();
}

export function inspectApkSigningCertificateSha256(apkPath, options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const apksignerPath = resolveApksignerPath(root, options.apksignerPath ?? null);
  const execution = spawnSync(
    apksignerPath,
    ["verify", "--print-certs", apkPath],
    {
      encoding: "utf8",
      maxBuffer: MAX_APKSIGNER_OUTPUT_BYTES,
      timeout: APKSIGNER_TIMEOUT_MS,
      windowsHide: true,
    }
  );
  if (
    execution.error !== undefined ||
    execution.signal !== null ||
    execution.status !== 0
  ) {
    fail("APK_SIGNATURE_VERIFICATION_FAILED", "apksigner rejected the certified Lab APK");
  }
  return parseApksignerCertificateSha256(execution.stdout);
}

function singleMatch(text, expression, label) {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) {
    fail("GRADLE_IDENTITY_INVALID", `${label} must appear exactly once`);
  }
  return matches[0];
}

function namedBlock(source, name) {
  const marker = new RegExp(`\\b${name}\\s*\\{`, "u").exec(source);
  if (!marker) fail("GRADLE_IDENTITY_INVALID", `${name} block is missing`);
  const opening = source.indexOf("{", marker.index);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(opening + 1, index);
    }
  }
  fail("GRADLE_IDENTITY_INVALID", `${name} block is unterminated`);
}

function resolveApplicationId(source, expression) {
  if (/^"[A-Za-z0-9_.]+"$/u.test(expression)) return expression.slice(1, -1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(expression)) {
    fail("GRADLE_IDENTITY_INVALID", "applicationId expression is unsupported");
  }
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declaration = singleMatch(
    source,
    new RegExp(`\\bval\\s+${escaped}\\s*=([\\s\\S]*?)(?=\\n(?:val\\s+|android\\s*\\{))`, "gu"),
    `Gradle variable ${expression}`,
  )[1];
  const direct = declaration.match(/^\s*"([A-Za-z0-9_.]+)"\s*$/u);
  if (direct) return direct[1];
  const fallback = singleMatch(
    declaration,
    /\.getOrElse\(\s*"([A-Za-z0-9_.]+)"\s*\)/gu,
    `Gradle default for ${expression}`,
  );
  return fallback[1];
}

export function parseGradleIdentity(source, role) {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_TEXT_BYTES) {
    fail("GRADLE_IDENTITY_INVALID", "Gradle source is invalid");
  }
  const roleConfig = ROLES[role];
  if (!roleConfig) fail("ROLE_INVALID", "Android role is invalid");
  const defaultConfig = namedBlock(source, "defaultConfig");
  const applicationExpression = singleMatch(
    defaultConfig,
    /\bapplicationId\s*=\s*("[A-Za-z0-9_.]+"|[A-Za-z_][A-Za-z0-9_]*)/gu,
    `${role} applicationId`,
  )[1];
  const versionCode = Number(
    singleMatch(defaultConfig, /\bversionCode\s*=\s*([0-9]+)/gu, `${role} versionCode`)[1],
  );
  const versionName = singleMatch(
    defaultConfig,
    /\bversionName\s*=\s*"([0-9]+(?:\.[0-9]+){2})"/gu,
    `${role} versionName`,
  )[1];
  const nodeKind = singleMatch(
    defaultConfig,
    new RegExp(
      String.raw`buildConfigField\(\s*"String"\s*,\s*"BLUETOOTH_NODE_KIND"\s*,\s*"\\"(handheld|station)\\""\s*\)`,
      "gu",
    ),
    `${role} BLUETOOTH_NODE_KIND`,
  )[1];
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    fail("GRADLE_IDENTITY_INVALID", `${role} versionCode is invalid`);
  }
  if (nodeKind !== roleConfig.expectedNodeKind) {
    fail("ROLE_BINDING_MISMATCH", `${role} BLUETOOTH_NODE_KIND is invalid`);
  }
  return Object.freeze({
    packageId: resolveApplicationId(source, applicationExpression),
    versionCode,
    versionName,
    nodeKind,
  });
}

export function certifiedLabArtifactRelativePath(target) {
  if (
    target === null ||
    typeof target !== "object" ||
    typeof target.artifactRelativePath !== "string"
  ) {
    fail("CERTIFIED_ARTIFACT_PATH_INVALID", "certified Lab artifact path is unavailable");
  }
  return target.artifactRelativePath;
}

function captureCertifiedArtifactPath(root, artifactRelativePath, role) {
  const segments = artifactRelativePath.split("/");
  const artifactRoot = path.resolve(root, "artifacts");
  const absolutePath = path.resolve(root, ...segments);
  if (
    segments[0] !== "artifacts" ||
    absolutePath === artifactRoot ||
    !absolutePath.startsWith(`${artifactRoot}${path.sep}`)
  ) {
    fail("CERTIFIED_ARTIFACT_PATH_INVALID", `${role} certified Lab artifact path escapes artifacts/`);
  }

  const ancestors = [];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = fs.lstatSync(current);
    } catch {
      fail("CERTIFIED_ARTIFACT_PATH_INVALID", `${role} certified Lab artifact parent is unavailable`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("CERTIFIED_ARTIFACT_PATH_INVALID", `${role} certified Lab artifact parent must be a real directory`);
    }
    ancestors.push(Object.freeze({ filePath: current, metadata }));
  }
  let artifactMetadata;
  try {
    artifactMetadata = fs.lstatSync(absolutePath);
  } catch {
    fail("FILE_UNAVAILABLE", `${role} named Lab APK is unavailable`);
  }
  if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isFile()) {
    fail("CERTIFIED_ARTIFACT_PATH_INVALID", `${role} certified Lab artifact must be a real file`);
  }
  return Object.freeze({
    absolutePath,
    ancestors: Object.freeze(ancestors),
    artifactMetadata,
  });
}

function assertCertifiedArtifactPathUnchanged(snapshot, role) {
  for (const ancestor of snapshot.ancestors) {
    let current;
    try {
      current = fs.lstatSync(ancestor.filePath);
    } catch {
      fail("CERTIFIED_ARTIFACT_PATH_CHANGED", `${role} certified Lab artifact parent changed while being read`);
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameFileSnapshot(ancestor.metadata, current)
    ) {
      fail("CERTIFIED_ARTIFACT_PATH_CHANGED", `${role} certified Lab artifact parent changed while being read`);
    }
  }
  let artifactMetadata;
  try {
    artifactMetadata = fs.lstatSync(snapshot.absolutePath);
  } catch {
    fail("CERTIFIED_ARTIFACT_PATH_CHANGED", `${role} certified Lab artifact changed while being read`);
  }
  if (
    artifactMetadata.isSymbolicLink() ||
    !artifactMetadata.isFile() ||
    !sameFileSnapshot(snapshot.artifactMetadata, artifactMetadata)
  ) {
    fail("CERTIFIED_ARTIFACT_PATH_CHANGED", `${role} certified Lab artifact changed while being read`);
  }
}

function listTreeFiles(directory, label) {
  let rootMetadata;
  try {
    rootMetadata = fs.lstatSync(directory);
  } catch {
    fail("SOURCE_TREE_UNAVAILABLE", `${label} is unavailable`);
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail("SOURCE_TREE_INVALID", `${label} must be a directory`);
  }
  const output = [];
  const visit = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail("SOURCE_SYMLINK_FORBIDDEN", `${label}/${relative} is a symlink`);
      if (metadata.isDirectory()) visit(absolute, relative);
      else if (metadata.isFile()) output.push(relative);
      else fail("SOURCE_TREE_INVALID", `${label}/${relative} is not a regular file`);
    }
  };
  visit(directory, "");
  return output;
}

function compareInventory(left, right, label) {
  if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) {
    fail("SOURCE_INVENTORY_MISMATCH", `${label} inventories differ`);
  }
}

function requireRoleAwareFailoverSource(source, role) {
  if (
    !source.includes("BuildConfig.BLUETOOTH_NODE_KIND") ||
    !source.includes("BluetoothAdvertisementNodeKind.fromBuildConfig")
  ) {
    fail("ROLE_BINDING_MISSING", `${role} failover service does not consume BLUETOOTH_NODE_KIND`);
  }
  if (/fromBuildConfig\(\s*"(?:handheld|station)"\s*\)/u.test(source)) {
    fail("ROLE_BINDING_HARDCODED", `${role} failover service hardcodes its node kind`);
  }
}

export function verifyBluetoothParity(root) {
  const roots = Object.fromEntries(
    Object.entries(ROLES).map(([role, config]) => {
      const base = path.join(root, config.appRoot, "src");
      return [role, {
        main: path.join(base, "main/java/com/sentrapa/webkiosk/bluetooth"),
        test: path.join(base, "test/java/com/sentrapa/webkiosk/bluetooth"),
      }];
    }),
  );
  const inventories = {
    main: {
      handheld: listTreeFiles(roots.handheld.main, "handheld Bluetooth main"),
      station: listTreeFiles(roots.station.main, "station Bluetooth main"),
    },
    test: {
      handheld: listTreeFiles(roots.handheld.test, "handheld Bluetooth test"),
      station: listTreeFiles(roots.station.test, "station Bluetooth test"),
    },
  };
  compareInventory(inventories.main.handheld, inventories.main.station, "Bluetooth main");
  compareInventory(inventories.test.handheld, inventories.test.station, "Bluetooth test");

  const allowed = new Set(ALLOWED_MAIN_DIFFERENCES);
  const actualDifferences = [];
  for (const relative of inventories.main.handheld) {
    const handheld = readBuffer(path.join(roots.handheld.main, relative), `handheld Bluetooth main/${relative}`);
    const station = readBuffer(path.join(roots.station.main, relative), `station Bluetooth main/${relative}`);
    if (!handheld.equals(station)) {
      if (!allowed.has(relative)) {
        fail("SOURCE_BYTE_MISMATCH", `unexpected Bluetooth main difference: ${relative}`);
      }
      actualDifferences.push(relative);
    }
  }
  for (const relative of inventories.test.handheld) {
    const handheld = readBuffer(path.join(roots.handheld.test, relative), `handheld Bluetooth test/${relative}`);
    const station = readBuffer(path.join(roots.station.test, relative), `station Bluetooth test/${relative}`);
    if (!handheld.equals(station)) {
      fail("TEST_BYTE_MISMATCH", `unexpected Bluetooth test difference: ${relative}`);
    }
  }
  for (const allowedFile of allowed) {
    if (!inventories.main.handheld.includes(allowedFile)) {
      fail("ALLOWLIST_TARGET_MISSING", `Bluetooth allowlist target is missing: ${allowedFile}`);
    }
  }
  requireRoleAwareFailoverSource(
    readText(path.join(roots.handheld.main, "BluetoothFailoverService.kt"), "handheld BluetoothFailoverService.kt"),
    "handheld",
  );
  requireRoleAwareFailoverSource(
    readText(path.join(roots.station.main, "BluetoothFailoverService.kt"), "station BluetoothFailoverService.kt"),
    "station",
  );
  return Object.freeze({
    mainFiles: inventories.main.handheld.length,
    testFiles: inventories.test.handheld.length,
    allowedDifferenceFiles: Object.freeze([...ALLOWED_MAIN_DIFFERENCES]),
    actualDifferenceFiles: Object.freeze(actualDifferences),
  });
}

function sha256File(filePath, label) {
  const { before, descriptor } = openStableRegularFile(filePath, label, 256 * 1024 * 1024);
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
    closeStableRegularFile(filePath, label, before, descriptor);
  } finally {
    try { fs.closeSync(descriptor); } catch {}
  }
  return digest.digest("hex");
}

export function verifyAdvancedBuildConsistency(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const matrixPath = path.resolve(options.matrixPath ?? path.join(root, MATRIX_RELATIVE));
  const signingCertificateInspector = options.signingCertificateInspector ??
    ((apkPath) => inspectApkSigningCertificateSha256(apkPath, {
      root,
      apksignerPath: options.apksignerPath ?? null,
    }));
  const checks = [];
  const roles = {};
  try {
    if (typeof signingCertificateInspector !== "function") {
      fail("SIGNING_CERTIFICATE_INSPECTOR_INVALID", "signing certificate inspector must be a function");
    }
    const matrix = loadAdvancedCertificationTargets(matrixPath);
    for (const [role, config] of Object.entries(ROLES)) {
      const target = matrix.roles[role];
      const buildPath = path.join(root, config.appRoot, "build.gradle.kts");
      const identity = parseGradleIdentity(readText(buildPath, `${role} build.gradle.kts`), role);
      if (
        identity.packageId !== target.packageId ||
        identity.versionName !== target.versionName ||
        identity.versionCode !== target.versionCode
      ) {
        fail("CERTIFICATION_MATRIX_MISMATCH", `${role} Gradle identity does not match the certification matrix`);
      }
      if (identity.nodeKind !== config.expectedNodeKind) {
        fail("ROLE_BINDING_MISMATCH", `${role} BLUETOOTH_NODE_KIND is invalid`);
      }
      const artifactRelativePath = certifiedLabArtifactRelativePath(target);
      const artifactSnapshot = captureCertifiedArtifactPath(root, artifactRelativePath, role);
      const apkSha256 = sha256File(artifactSnapshot.absolutePath, `${role} named Lab APK`);
      assertCertifiedArtifactPathUnchanged(artifactSnapshot, role);
      if (apkSha256 !== target.sha256) {
        fail("CERTIFIED_APK_MISMATCH", `${role} named Lab APK SHA-256 does not match the certification matrix`);
      }
      const signingCertificateSha256 = signingCertificateInspector(
        artifactSnapshot.absolutePath,
        Object.freeze({ role, target })
      );
      assertCertifiedArtifactPathUnchanged(artifactSnapshot, role);
      if (
        typeof signingCertificateSha256 !== "string" ||
        signingCertificateSha256 !== target.signingCertificateSha256
      ) {
        fail(
          "CERTIFIED_SIGNING_CERTIFICATE_MISMATCH",
          `${role} Lab APK signing certificate SHA-256 does not match the certification matrix`
        );
      }
      roles[role] = Object.freeze({
        ...identity,
        artifactRelativePath,
        apkSha256,
        signingCertificateSha256,
      });
      checks.push(Object.freeze({ id: `${role}.identity`, status: "PASS" }));
      checks.push(Object.freeze({ id: `${role}.apkSha256`, status: "PASS" }));
      checks.push(Object.freeze({ id: `${role}.signingCertificateSha256`, status: "PASS" }));
      checks.push(Object.freeze({ id: `${role}.nodeKind`, status: "PASS" }));
    }
    const parity = verifyBluetoothParity(root);
    checks.push(Object.freeze({ id: "bluetooth.sourceParity", status: "PASS" }));
    checks.push(Object.freeze({ id: "bluetooth.testParity", status: "PASS" }));
    return Object.freeze({
      schemaVersion: 1,
      product: "V5BT",
      ok: true,
      checks: Object.freeze(checks),
      roles: Object.freeze(roles),
      parity,
      errors: Object.freeze([]),
    });
  } catch (error) {
    const code = error instanceof BuildConsistencyError ? error.code : "CONSISTENCY_CHECK_FAILED";
    return Object.freeze({
      schemaVersion: 1,
      product: "V5BT",
      ok: false,
      checks: Object.freeze(checks),
      roles: Object.freeze(roles),
      parity: null,
      errors: Object.freeze([{ code, message: error instanceof Error ? error.message : "unknown error" }]),
    });
  }
}

function parseCli(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && index + 1 < argv.length) {
      root = argv[++index];
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      return { help: true, root };
    } else {
      fail("ARGUMENT_INVALID", `unsupported argument: ${argv[index]}`);
    }
  }
  return { help: false, root };
}

function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    process.stdout.write("Usage: node scripts/verify-v5bt-advanced-build-consistency.mjs [--root WORKSPACE]\n");
    return;
  }
  const result = verifyAdvancedBuildConsistency({ root: cli.root });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
