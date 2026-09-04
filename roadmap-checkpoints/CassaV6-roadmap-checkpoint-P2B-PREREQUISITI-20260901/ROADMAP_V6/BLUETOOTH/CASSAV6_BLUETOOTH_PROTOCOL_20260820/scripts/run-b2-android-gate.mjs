#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from './advanced-certification-targets.mjs';

const execFileAsync = promisify(execFile);
const STATUS_PATH = 'no_backup/bluetooth-discovery-status-v1.json';
const STATUS_MISSING_LINE = `cat: ${STATUS_PATH}: No such file or directory`;
const STATUS_LIMIT_BYTES = 16_384;
const STATUS_SYNTAX_READ_ATTEMPTS = 3;
const STATUS_SYNTAX_RETRY_DELAY_MS = 25;
const B2_P95_LIMIT_MS = 8_000;
const TERMINAL_READINESS_GRACE_MS = B2_P95_LIMIT_MS;
const TERMINAL_READINESS_MIN_SAMPLES = 3;
const DEFAULT_CYCLES = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_CYCLE_GAP_MS = 500;
const COOLDOWN_PILOT_CYCLES = 20;
const COOLDOWN_PILOT_MIN_QUIESCENCE_MS = 31_000;
const COOLDOWN_PILOT_MAX_QUIESCENCE_MS = 120_000;
const FORMAL_MIN_QUIESCENCE_MS = 31_000;
const FORMAL_MAX_QUIESCENCE_MS = 120_000;
const REPORT_SCHEMA_VERSION = 7;
const MIN_ANDROID_API = 33;
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;
const DEVICE_CLOCK_TOLERANCE_MS = 5_000;
const REQUIRED_DISTINCT_SAMPLES = 2;
const CERTIFICATION_TARGET_FIELDS = Object.freeze([
  'artifactRelativePath',
  'packageId',
  'sha256',
  'signingCertificateSha256',
  'versionCode',
  'versionName'
]);
const EXPECTED_TARGETS = Object.freeze({
  handheld: Object.freeze({
    serial: 'RFGYA0ZAGFW',
    model: 'SM-A165F',
    ...ADVANCED_CERTIFICATION_TARGETS.roles.handheld,
    nodeKind: 'handheld'
  }),
  station: Object.freeze({
    serial: 'R9WT50ZN5VZ',
    model: 'SM-T503',
    ...ADVANCED_CERTIFICATION_TARGETS.roles.station,
    nodeKind: 'station'
  })
});
const EXPECTED_DEVICE_SERIALS = Object.freeze(
  Object.values(EXPECTED_TARGETS).map((target) => target.serial)
);
const RUNTIME_REDACTION_SECRETS = new Set(EXPECTED_DEVICE_SERIALS);
const BLUETOOTH_PERMISSIONS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT'
];
const CRITICAL_ZERO_METRICS = [
  'scanFailures',
  'advertisementFailures',
  'invalidPayloads',
  'scanIngressDropped'
];
const CRITICAL_ZERO_PEER_DIRECTORY_METRICS = [
  'ambiguousRejected',
  'conflicts',
  'directoryFull',
  'newStreamAttemptRateRejected',
  'capacityEvicted',
  'clockRegressions'
];
const READINESS_VALUES = new Set([
  'READY',
  'DISCOVERY_FEATURE_DISABLED',
  'IDENTITY_FEATURE_DISABLED',
  'PLATFORM_UNSUPPORTED',
  'IDENTITY_NOT_READY',
  'BLE_HARDWARE_UNAVAILABLE',
  'PERMISSIONS_REQUIRED',
  'ADAPTER_DISABLED',
  'CAPABILITY_NOT_FULL_NODE'
]);
const TERMINAL_READINESS = new Set([
  'DISCOVERY_FEATURE_DISABLED',
  'IDENTITY_FEATURE_DISABLED',
  'PLATFORM_UNSUPPORTED',
  'BLE_HARDWARE_UNAVAILABLE',
  'PERMISSIONS_REQUIRED',
  'ADAPTER_DISABLED',
  'CAPABILITY_NOT_FULL_NODE'
]);
const FORBIDDEN_STATUS_KEY_PARTS = [
  'alias',
  'nodeid',
  'token',
  'secret',
  'privatekey',
  'publickey',
  'certificate',
  'macaddress',
  'enrollment'
];
const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'source',
  'labBuild',
  'diagnosticsEnabled',
  'sampleSequence',
  'sampledAtEpochMs',
  'reporterStartedAtEpochMs',
  'readiness',
  'ready',
  'radioActive',
  'scanProfile',
  'activePeerCount',
  'metrics'
];
const METRIC_KEYS = [
  'scanWindowsStarted',
  'concurrentScanAdvertiseWindowsStarted',
  'scanWindowsCompleted',
  'scanFailures',
  'advertisementsStarted',
  'advertisementUpdates',
  'advertisementFailures',
  'invalidPayloads',
  'acceptedObservations',
  'scanIngressDropped',
  'peerExpiryCount',
  'firstObservationOffsetP95Ms',
  'peerDirectory'
];
const PEER_DIRECTORY_KEYS = [
  'added',
  'updated',
  'duplicateRefreshes',
  'belowRssiFloor',
  'olderRejected',
  'ambiguousRejected',
  'conflicts',
  'directoryFull',
  'newStreamAttemptRateRejected',
  'capacityEvicted',
  'clockRegressions',
  'expired',
  'prunePasses',
  'newStreamAttempts',
  'newStreamsAccepted',
  'newStreamAttemptWindowsStarted',
  'capacityHighWatermark'
];

class B2GateError extends Error {
  constructor(
    code,
    message,
    {
      fatal = true,
      lastStatuses = [],
      cycleDevices = [],
      cycleElapsedMs = null,
      harnessObservationCensorAtMs = null,
      detailCode = null,
      failedRole = null
    } = {}
  ) {
    super(message);
    this.name = 'B2GateError';
    this.code = code;
    this.fatal = fatal;
    this.lastStatuses = lastStatuses;
    this.cycleDevices = cycleDevices;
    this.cycleElapsedMs = cycleElapsedMs;
    this.harnessObservationCensorAtMs = harnessObservationCensorAtMs;
    this.detailCode = detailCode;
    this.failedRole = failedRole;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-b2-android-gate.mjs --self-test',
    '  node scripts/run-b2-android-gate.mjs --dry-run [options]',
    '  node scripts/run-b2-android-gate.mjs --diagnostic-handheld-pair \\',
    '    --handheld-a-serial SERIAL --handheld-b-serial SERIAL [options]',
    '  node scripts/run-b2-android-gate.mjs --diagnostic-cooldown-pilot \\',
    '    --handheld-a-serial SERIAL --handheld-b-serial SERIAL [options]',
    '  node scripts/run-b2-android-gate.mjs \\',
    '    --handheld-serial SERIAL --station-serial SERIAL [options]',
    '',
    'Scope: discovery-only B2 gate for two already-enrolled Lab apps.',
    'The harness never closes physical B2 without independent capture review.',
    'Use run-b2-android-adb-harness.mjs for enrollment and capture workflows.',
    'The handheld-pair diagnostic emits NON_GATE_EVIDENCE and cannot promote B2.',
    `Formal B2 requires ${DEFAULT_CYCLES} measured quiescence windows of >= ${FORMAL_MIN_QUIESCENCE_MS} ms, one before every cycle.`,
    `The cooldown pilot is fixed to ${COOLDOWN_PILOT_CYCLES} cycles with >= ${COOLDOWN_PILOT_MIN_QUIESCENCE_MS} ms before every cycle.`,
    '',
    'Options:',
    `  --cycles N                 1..100 for dry-run; formal/standard diagnostic runs require ${DEFAULT_CYCLES}`,
    `  --timeout-ms N             8000..60000, default ${DEFAULT_TIMEOUT_MS}`,
    `  --poll-ms N                100..1000, default ${DEFAULT_POLL_MS}`,
    `  --cycle-gap-ms N           non-pilot diagnostic only, 0..5000, default ${DEFAULT_CYCLE_GAP_MS}`,
    `  --formal-quiescence-ms N   formal B2 only, ${FORMAL_MIN_QUIESCENCE_MS}..${FORMAL_MAX_QUIESCENCE_MS}`,
    `  --quiescence-ms N          cooldown pilot only, ${COOLDOWN_PILOT_MIN_QUIESCENCE_MS}..${COOLDOWN_PILOT_MAX_QUIESCENCE_MS}`,
    '  --handheld-package ID      fixed Palmare Advanced package',
    '  --station-package ID       fixed Postazione Advanced package',
    '  --diagnostic-handheld-pair diagnostic only; formal targets stay unchanged',
    '  --diagnostic-cooldown-pilot fixed non-gate 20-cycle cooldown pilot',
    '  --handheld-a-serial SERIAL first diagnostic Palmare ADB serial',
    '  --handheld-b-serial SERIAL second diagnostic Palmare ADB serial',
    '  --rf-evidence FILE         required non-empty controlled-RF evidence',
    '  --capture-evidence FILE    required non-empty controller capture evidence',
    '  --adb PATH                 default $ADB or adb',
    '  --output FILE              optional redacted JSON evidence file',
    '  --help'
  ].join('\n');
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^(0|[1-9]\d*)$/.test(value ?? '')) {
    throw new B2GateError('INVALID_ARGUMENT', `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new B2GateError(
      'INVALID_ARGUMENT',
      `${name} must be between ${minimum} and ${maximum}`
    );
  }
  return parsed;
}

function validatePackageId(value, name) {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)
  ) {
    throw new B2GateError('INVALID_ARGUMENT', `${name} is not a valid package ID`);
  }
  return value;
}

function validateSerial(value, name) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    /[\s\x00-\x1f\x7f]/.test(value)
  ) {
    throw new B2GateError('INVALID_ARGUMENT', `${name} is invalid`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    selfTest: false,
    dryRun: false,
    diagnosticHandheldPair: false,
    diagnosticCooldownPilot: false,
    help: false,
    adb: process.env.ADB || 'adb',
    cycles: DEFAULT_CYCLES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    cycleGapMs: DEFAULT_CYCLE_GAP_MS,
    formalQuiescenceMs: FORMAL_MIN_QUIESCENCE_MS,
    quiescenceMs: COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
    handheldSerial: null,
    stationSerial: null,
    handheldASerial: null,
    handheldBSerial: null,
    handheldPackage: EXPECTED_TARGETS.handheld.packageId,
    stationPackage: EXPECTED_TARGETS.station.packageId,
    rfEvidence: null,
    captureEvidence: null,
    output: null
  };
  const valueOptions = new Set([
    '--adb',
    '--cycles',
    '--timeout-ms',
    '--poll-ms',
    '--cycle-gap-ms',
    '--formal-quiescence-ms',
    '--quiescence-ms',
    '--handheld-serial',
    '--station-serial',
    '--handheld-a-serial',
    '--handheld-b-serial',
    '--handheld-package',
    '--station-package',
    '--rf-evidence',
    '--capture-evidence',
    '--output'
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) {
      throw new B2GateError('INVALID_ARGUMENT', `duplicate option: ${argument}`);
    }
    if (argument === '--self-test') {
      options.selfTest = true;
      seen.add(argument);
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      seen.add(argument);
      continue;
    }
    if (argument === '--diagnostic-handheld-pair') {
      options.diagnosticHandheldPair = true;
      seen.add(argument);
      continue;
    }
    if (argument === '--diagnostic-cooldown-pilot') {
      options.diagnosticHandheldPair = true;
      options.diagnosticCooldownPilot = true;
      seen.add(argument);
      continue;
    }
    if (argument === '--help') {
      options.help = true;
      seen.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new B2GateError('INVALID_ARGUMENT', `unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new B2GateError('INVALID_ARGUMENT', `missing value for ${argument}`);
    }
    seen.add(argument);
    index += 1;
    switch (argument) {
      case '--adb':
        options.adb = value;
        break;
      case '--cycles':
        options.cycles = parseInteger(value, argument, 1, 100);
        break;
      case '--timeout-ms':
        options.timeoutMs = parseInteger(value, argument, B2_P95_LIMIT_MS, 60_000);
        break;
      case '--poll-ms':
        options.pollMs = parseInteger(value, argument, 100, 1_000);
        break;
      case '--cycle-gap-ms':
        options.cycleGapMs = parseInteger(value, argument, 0, 5_000);
        break;
      case '--formal-quiescence-ms':
        options.formalQuiescenceMs = parseInteger(
          value,
          argument,
          FORMAL_MIN_QUIESCENCE_MS,
          FORMAL_MAX_QUIESCENCE_MS
        );
        break;
      case '--quiescence-ms':
        options.quiescenceMs = parseInteger(
          value,
          argument,
          COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
          COOLDOWN_PILOT_MAX_QUIESCENCE_MS
        );
        break;
      case '--handheld-serial':
        options.handheldSerial = validateSerial(value, argument);
        RUNTIME_REDACTION_SECRETS.add(options.handheldSerial);
        break;
      case '--station-serial':
        options.stationSerial = validateSerial(value, argument);
        RUNTIME_REDACTION_SECRETS.add(options.stationSerial);
        break;
      case '--handheld-a-serial':
        options.handheldASerial = validateSerial(value, argument);
        RUNTIME_REDACTION_SECRETS.add(options.handheldASerial);
        break;
      case '--handheld-b-serial':
        options.handheldBSerial = validateSerial(value, argument);
        RUNTIME_REDACTION_SECRETS.add(options.handheldBSerial);
        break;
      case '--handheld-package':
        options.handheldPackage = validatePackageId(value, argument);
        break;
      case '--station-package':
        options.stationPackage = validatePackageId(value, argument);
        break;
      case '--rf-evidence':
        options.rfEvidence = path.resolve(value);
        break;
      case '--capture-evidence':
        options.captureEvidence = path.resolve(value);
        break;
      case '--output':
        options.output = path.resolve(value);
        break;
      default:
        throw new B2GateError('INVALID_ARGUMENT', `unsupported option: ${argument}`);
    }
  }
  validatePackageId(options.handheldPackage, '--handheld-package');
  validatePackageId(options.stationPackage, '--station-package');
  if (options.diagnosticCooldownPilot) {
    if (
      seen.has('--diagnostic-handheld-pair') ||
      seen.has('--cycles') ||
      seen.has('--cycle-gap-ms') ||
      seen.has('--formal-quiescence-ms')
    ) {
      throw new B2GateError(
        'COOLDOWN_PILOT_CONTRACT_INVALID',
        'cooldown pilot fixes its mode, cycle count and inter-cycle quiescence contract'
      );
    }
    options.cycles = COOLDOWN_PILOT_CYCLES;
  } else if (seen.has('--quiescence-ms')) {
    throw new B2GateError(
      'COOLDOWN_PILOT_CONTRACT_INVALID',
      '--quiescence-ms is valid only with --diagnostic-cooldown-pilot'
    );
  }
  if (options.diagnosticHandheldPair) {
    if (
      options.handheldPackage !== EXPECTED_TARGETS.handheld.packageId ||
      [
        '--handheld-serial',
        '--station-serial',
        '--station-package',
        '--formal-quiescence-ms',
        '--rf-evidence',
        '--capture-evidence'
      ].some((argument) => seen.has(argument))
    ) {
      throw new B2GateError(
        'DIAGNOSTIC_ISOLATION_INVALID',
        'handheld-pair diagnostics cannot reuse or alter formal B2 target inputs'
      );
    }
    if (
      options.handheldASerial !== null &&
      options.handheldASerial === options.handheldBSerial
    ) {
      throw new B2GateError(
        'INVALID_ARGUMENT',
        'diagnostic handhelds must use different ADB serials'
      );
    }
  } else if (
    options.handheldPackage !== EXPECTED_TARGETS.handheld.packageId ||
    options.stationPackage !== EXPECTED_TARGETS.station.packageId ||
    options.handheldPackage === options.stationPackage ||
    seen.has('--handheld-a-serial') ||
    seen.has('--handheld-b-serial')
  ) {
    throw new B2GateError(
      'TARGET_ROLE_MISMATCH',
      'Palmare and Postazione packages are fixed to their expected node roles'
    );
  }
  if (!options.diagnosticHandheldPair && seen.has('--cycle-gap-ms')) {
    throw new B2GateError(
      'FORMAL_QUIESCENCE_CONTRACT_INVALID',
      'formal B2 uses measured quiescence before every cycle and does not accept --cycle-gap-ms'
    );
  }
  if (!options.selfTest && !options.dryRun && !options.help) {
    if (
      options.diagnosticHandheldPair &&
      (!options.handheldASerial || !options.handheldBSerial)
    ) {
      throw new B2GateError(
        'INVALID_ARGUMENT',
        '--handheld-a-serial and --handheld-b-serial are required for diagnostics'
      );
    }
    if (
      options.diagnosticHandheldPair &&
      !options.diagnosticCooldownPilot &&
      options.cycles !== DEFAULT_CYCLES
    ) {
      throw new B2GateError(
        'DIAGNOSTIC_CYCLE_COUNT_INVALID',
        `physical handheld-pair diagnostics require exactly ${DEFAULT_CYCLES} cycles`
      );
    }
    if (options.diagnosticHandheldPair && options.output === null) {
      throw new B2GateError(
        'DIAGNOSTIC_OUTPUT_REQUIRED',
        '--output is required for physical handheld-pair evidence'
      );
    }
    if (
      !options.diagnosticHandheldPair &&
      (!options.handheldSerial || !options.stationSerial)
    ) {
      throw new B2GateError(
        'INVALID_ARGUMENT',
        '--handheld-serial and --station-serial are required'
      );
    }
    if (
      !options.diagnosticHandheldPair &&
      options.handheldSerial === options.stationSerial
    ) {
      throw new B2GateError(
        'INVALID_ARGUMENT',
        'handheld and station must use different ADB serials'
      );
    }
    if (
      !options.diagnosticHandheldPair &&
      (options.handheldSerial !== EXPECTED_TARGETS.handheld.serial ||
        options.stationSerial !== EXPECTED_TARGETS.station.serial)
    ) {
      throw new B2GateError(
        'TARGET_ROLE_MISMATCH',
        'ADB serials do not match the fixed Palmare and Postazione targets'
      );
    }
    if (!options.diagnosticHandheldPair && options.cycles !== DEFAULT_CYCLES) {
      throw new B2GateError(
        'CERTIFICATION_CYCLE_COUNT_INVALID',
        `physical B2 certification requires exactly ${DEFAULT_CYCLES} cycles`
      );
    }
    if (
      !options.diagnosticHandheldPair &&
      (!options.rfEvidence || !options.captureEvidence)
    ) {
      throw new B2GateError(
        'EXTERNAL_EVIDENCE_REQUIRED',
        '--rf-evidence and --capture-evidence are required for physical certification'
      );
    }
    if (
      !options.diagnosticHandheldPair &&
      (options.rfEvidence === options.captureEvidence ||
        options.output === options.rfEvidence ||
        options.output === options.captureEvidence)
    ) {
      throw new B2GateError(
        'EXTERNAL_EVIDENCE_INVALID',
        'RF evidence, controller capture and output must use distinct files'
      );
    }
  }
  return options;
}

function inspectEvidenceFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new B2GateError(
      'EXTERNAL_EVIDENCE_INVALID',
      `${label} must reference a readable regular file`
    );
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > MAX_EVIDENCE_BYTES ||
    (process.platform === 'linux' && (stat.mode & 0o777) !== 0o600) ||
    (process.platform === 'linux' &&
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid())
  ) {
    throw new B2GateError(
      'EXTERNAL_EVIDENCE_INVALID',
      `${label} must be an owned single-link 0600 file within the size limit`
    );
  }
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new B2GateError(
      'EXTERNAL_EVIDENCE_INVALID',
      `${label} is not readable`
    );
  }
  return true;
}

function redactText(value, secrets) {
  let redacted = String(value ?? '');
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[DEVICE_SERIAL]');
  }
  return redacted.trim();
}

async function runCommand(executable, args, secrets, timeoutMs = 30_000) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    };
  } catch (error) {
    const detail = redactText(
      error.stderr || error.stdout || error.message || 'command failed',
      secrets
    );
    throw new B2GateError('COMMAND_FAILED', detail || 'command failed');
  }
}

async function runAdb(options, serial, args, timeoutMs) {
  const serials = [options.handheldSerial, options.stationSerial].filter(Boolean);
  const prefix = serial ? ['-s', serial] : [];
  return runCommand(options.adb, [...prefix, ...args], serials, timeoutMs);
}

function statusValidationError(detailCode, message, code = 'STATUS_INVALID') {
  return new B2GateError(code, message, { detailCode });
}

function exactKeys(value, expected, label, detailPrefix) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw statusValidationError(
      `${detailPrefix}_NOT_OBJECT`,
      `${label} must be an object`
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw statusValidationError(
      `${detailPrefix}_FIELDS_INVALID`,
      `${label} contains unexpected fields`
    );
  }
}

function assertNoForbiddenKeys(value, pathLabel = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${pathLabel}[${index}]`));
    return;
  }
  if (value == null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '');
    if (FORBIDDEN_STATUS_KEY_PARTS.some((part) => normalized.includes(part))) {
      throw statusValidationError(
        'FORBIDDEN_FIELD_PRESENT',
        `diagnostic status contains forbidden field at ${pathLabel}`,
        'STATUS_NOT_REDACTED'
      );
    }
    assertNoForbiddenKeys(entry, `${pathLabel}.${key}`);
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    const normalizedLabel = label
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .toUpperCase();
    throw statusValidationError(
      `${normalizedLabel}_NOT_NONNEGATIVE_INTEGER`,
      `${label} must be a non-negative integer`
    );
  }
}

function parseStatus(raw) {
  if (Buffer.byteLength(raw, 'utf8') > STATUS_LIMIT_BYTES) {
    throw statusValidationError(
      'STATUS_SIZE_LIMIT_EXCEEDED',
      'diagnostic status exceeds size limit'
    );
  }
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    throw statusValidationError(
      'JSON_SYNTAX_INVALID',
      'diagnostic status is not valid JSON'
    );
  }
  assertNoForbiddenKeys(status);
  exactKeys(status, TOP_LEVEL_KEYS, 'status', 'STATUS');
  exactKeys(status.metrics, METRIC_KEYS, 'status.metrics', 'METRICS');
  exactKeys(
    status.metrics.peerDirectory,
    PEER_DIRECTORY_KEYS,
    'status.metrics.peerDirectory',
    'PEER_DIRECTORY'
  );
  if (
    status.schemaVersion !== 1 ||
    status.source !== 'V6_ANDROID_DISCOVERY_LAB' ||
    status.labBuild !== true ||
    status.diagnosticsEnabled !== true
  ) {
    throw statusValidationError(
      'LAB_MARKERS_INVALID',
      'diagnostic status is not a V6 Lab report'
    );
  }
  requireNonNegativeInteger(status.sampleSequence, 'sampleSequence');
  if (status.sampleSequence === 0) {
    throw statusValidationError(
      'SAMPLE_SEQUENCE_ZERO',
      'sampleSequence must start at one'
    );
  }
  requireNonNegativeInteger(status.sampledAtEpochMs, 'sampledAtEpochMs');
  requireNonNegativeInteger(status.reporterStartedAtEpochMs, 'reporterStartedAtEpochMs');
  if (!READINESS_VALUES.has(status.readiness)) {
    throw statusValidationError('READINESS_INVALID', 'readiness is invalid');
  }
  if (status.ready !== (status.readiness === 'READY')) {
    throw statusValidationError(
      'READY_READINESS_MISMATCH',
      'ready does not match readiness'
    );
  }
  if (typeof status.radioActive !== 'boolean') {
    throw statusValidationError(
      'RADIO_ACTIVE_TYPE_INVALID',
      'radioActive must be boolean'
    );
  }
  if (status.scanProfile !== 'STABLE' && status.scanProfile !== 'FAILOVER') {
    throw statusValidationError('SCAN_PROFILE_INVALID', 'scanProfile is invalid');
  }
  requireNonNegativeInteger(status.activePeerCount, 'activePeerCount');
  if (status.activePeerCount > 1_024) {
    throw statusValidationError(
      'ACTIVE_PEER_COUNT_LIMIT_EXCEEDED',
      'activePeerCount exceeds the B2 limit'
    );
  }
  for (const key of METRIC_KEYS) {
    if (key === 'peerDirectory' || key === 'firstObservationOffsetP95Ms') continue;
    requireNonNegativeInteger(status.metrics[key], `metrics.${key}`);
  }
  if (status.metrics.firstObservationOffsetP95Ms !== null) {
    requireNonNegativeInteger(
      status.metrics.firstObservationOffsetP95Ms,
      'metrics.firstObservationOffsetP95Ms'
    );
  }
  for (const key of PEER_DIRECTORY_KEYS) {
    requireNonNegativeInteger(
      status.metrics.peerDirectory[key],
      `metrics.peerDirectory.${key}`
    );
  }
  return status;
}

function nearestRankP95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function measureMinimumQuiescence(
  requiredMs,
  { now = () => performance.now(), sleepFn = sleep } = {}
) {
  const startedAt = now();
  let observedMs = 0;
  do {
    await sleepFn(Math.max(1, requiredMs - observedMs));
    observedMs = Math.floor(now() - startedAt);
  } while (observedMs < requiredMs);
  return observedMs;
}

async function parseStatusWithBoundedSyntaxRetry(
  readRaw,
  {
    attempts = STATUS_SYNTAX_READ_ATTEMPTS,
    retryDelayMs = STATUS_SYNTAX_RETRY_DELAY_MS,
    sleepFn = sleep
  } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const raw = await readRaw();
    if (raw === null) return null;
    try {
      return parseStatus(raw);
    } catch (error) {
      const retryableSyntaxRead =
        error instanceof B2GateError &&
        error.code === 'STATUS_INVALID' &&
        error.detailCode === 'JSON_SYNTAX_INVALID';
      if (!retryableSyntaxRead || attempt === attempts) {
        if (retryableSyntaxRead) {
          throw new B2GateError(error.code, error.message, {
            fatal: error.fatal,
            lastStatuses: error.lastStatuses,
            detailCode: 'JSON_SYNTAX_INVALID_PERSISTENT',
            failedRole: error.failedRole
          });
        }
        throw error;
      }
      await sleepFn(retryDelayMs);
    }
  }
  throw new B2GateError('UNEXPECTED_ERROR', 'status retry loop did not terminate');
}

function stripSingleTerminalLineEnding(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function isExactMissingStatusLine(value) {
  return stripSingleTerminalLineEnding(value) === STATUS_MISSING_LINE;
}

function statusPayloadFromCommandResult(result) {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (
    (stderr === '' && isExactMissingStatusLine(stdout)) ||
    (stdout === '' && isExactMissingStatusLine(stderr))
  ) {
    return null;
  }
  if (stderr !== '') {
    throw new B2GateError(
      'STATUS_READ_FAILED',
      'diagnostic status command produced unexpected stderr',
      { detailCode: 'STATUS_COMMAND_STDERR_UNEXPECTED' }
    );
  }
  return stdout;
}

function parseCurrentUser(raw, role) {
  const value = raw.trim();
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new B2GateError(
      'ANDROID_USER_INVALID',
      `${role} current Android user is invalid`
    );
  }
  const userId = Number(value);
  if (!Number.isSafeInteger(userId)) {
    throw new B2GateError(
      'ANDROID_USER_INVALID',
      `${role} current Android user is invalid`
    );
  }
  return userId;
}

function parseInstalledVersion(packageDump, role) {
  const codeMatch = packageDump.match(/^\s*versionCode=(\d+)\b/m);
  const nameMatch = packageDump.match(/^\s*versionName=([^\r\n]+)$/m);
  if (!codeMatch || !nameMatch) {
    throw new B2GateError(
      'APP_VERSION_UNAVAILABLE',
      `${role} installed app version is unavailable`
    );
  }
  const versionCode = Number(codeMatch[1]);
  const versionName = nameMatch[1].trim();
  if (!Number.isSafeInteger(versionCode) || versionName.length === 0) {
    throw new B2GateError(
      'APP_VERSION_UNAVAILABLE',
      `${role} installed app version is invalid`
    );
  }
  return { versionCode, versionName };
}

function parseInstalledApkPath(raw, role) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith('package:')) {
    throw new B2GateError(
      'APK_LAYOUT_INVALID',
      `${role} installed APK layout is not the certified single-APK layout`
    );
  }
  const apkPath = lines[0].slice('package:'.length);
  if (
    apkPath.length < 5 ||
    apkPath.length > 4_096 ||
    !apkPath.startsWith('/') ||
    !apkPath.endsWith('.apk') ||
    /[\s\x00-\x1f\x7f]/.test(apkPath)
  ) {
    throw new B2GateError(
      'APK_LAYOUT_INVALID',
      `${role} installed APK path is invalid`
    );
  }
  return apkPath;
}

function parseInstalledApkSha256(raw, role) {
  const match = String(raw ?? '').match(/^([0-9a-fA-F]{64})\s+\S+\s*$/);
  if (!match) {
    throw new B2GateError(
      'APK_SHA256_UNAVAILABLE',
      `${role} installed APK SHA-256 is unavailable`
    );
  }
  return match[1].toLowerCase();
}

function permissionGrantedForUser(packageDump, currentUser, permission) {
  if (
    typeof packageDump !== 'string' ||
    !Number.isSafeInteger(currentUser) ||
    currentUser < 0 ||
    typeof permission !== 'string'
  ) {
    return false;
  }
  const currentUserHeader = new RegExp(`^\\s*User ${currentUser}:`);
  const anyUserHeader = /^\s*User \d+:/;
  let insideCurrentUser = false;
  for (const line of packageDump.split(/\r?\n/)) {
    if (currentUserHeader.test(line)) {
      insideCurrentUser = true;
      continue;
    }
    if (insideCurrentUser && anyUserHeader.test(line)) break;
    if (
      insideCurrentUser &&
      line.includes(permission) &&
      /\bgranted=true\b/.test(line)
    ) {
      return true;
    }
  }
  return false;
}

function buildCurrentUserRunAsArgs(packageId, userId, ...command) {
  return [
    'exec-out',
    'run-as',
    packageId,
    '--user',
    String(userId),
    ...command
  ];
}

async function ensureAttached(options, devices) {
  await runAdb(options, null, ['version']);
  const { stdout } = await runAdb(options, null, ['devices']);
  const states = new Map(
    stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state] = line.split(/\s+/, 2);
        return [serial, state];
      })
  );
  for (const device of devices) {
    const state = states.get(device.serial);
    if (state !== 'device') {
      throw new B2GateError(
        'ADB_DEVICE_UNAVAILABLE',
        `${device.role} ADB state is ${state || 'missing'}`
      );
    }
  }
}

async function preflightDevice(options, device) {
  const targetRole = device.targetRole ?? device.role;
  const target = EXPECTED_TARGETS[targetRole];
  const diagnostic = options.diagnosticHandheldPair === true;
  if (
    !target ||
    (!diagnostic && device.serial !== target.serial) ||
    device.packageId !== target.packageId
  ) {
    throw new B2GateError(
      'TARGET_ROLE_MISMATCH',
      `${device.role} target and package are not the fixed B2 mapping`
    );
  }
  const currentUserResult = await runAdb(options, device.serial, [
    'shell',
    'am',
    'get-current-user'
  ]);
  const userId = parseCurrentUser(currentUserResult.stdout, device.role);
  device.userId = userId;
  const userArgument = String(userId);
  const [
    sdkResult,
    modelResult,
    featuresResult,
    bluetoothResult,
    packagePathResult,
    packageDumpResult,
    runAsResult
  ] = await Promise.all([
    runAdb(options, device.serial, ['shell', 'getprop', 'ro.build.version.sdk']),
    runAdb(options, device.serial, ['shell', 'getprop', 'ro.product.model']),
    runAdb(options, device.serial, ['shell', 'pm', 'list', 'features']),
    runAdb(options, device.serial, ['shell', 'settings', 'get', 'global', 'bluetooth_on']),
    runAdb(options, device.serial, [
      'shell',
      'pm',
      'path',
      '--user',
      userArgument,
      device.packageId
    ]),
    runAdb(options, device.serial, ['shell', 'dumpsys', 'package', device.packageId]),
    runAdb(
      options,
      device.serial,
      buildCurrentUserRunAsArgs(device.packageId, userId, 'pwd')
    )
  ]);
  const androidApi = Number(sdkResult.stdout.trim());
  if (!Number.isSafeInteger(androidApi) || androidApi < MIN_ANDROID_API) {
    throw new B2GateError(
      'ANDROID_API_UNSUPPORTED',
      `${device.role} requires Android API ${MIN_ANDROID_API} or newer`
    );
  }
  if (!featuresResult.stdout.includes('feature:android.hardware.bluetooth_le')) {
    throw new B2GateError(
      'BLE_FEATURE_MISSING',
      `${device.role} does not advertise android.hardware.bluetooth_le`
    );
  }
  if (bluetoothResult.stdout.trim() !== '1') {
    throw new B2GateError('BLUETOOTH_DISABLED', `${device.role} Bluetooth is disabled`);
  }
  if (!packagePathResult.stdout.trim().startsWith('package:')) {
    throw new B2GateError('PACKAGE_MISSING', `${device.role} Advanced app is not installed`);
  }
  if (!runAsResult.stdout.trim().includes(device.packageId)) {
    throw new B2GateError(
      'RUN_AS_UNAVAILABLE',
      `${device.role} Lab app must be debuggable for the current Android user`
    );
  }
  const missingPermissions = BLUETOOTH_PERMISSIONS.filter(
    (permission) =>
      !permissionGrantedForUser(
        packageDumpResult.stdout,
        userId,
        permission
      )
  );
  if (missingPermissions.length > 0) {
    throw new B2GateError(
      'BLUETOOTH_PERMISSIONS_MISSING',
      `${device.role} is missing required Bluetooth runtime permissions`
    );
  }
  const model = modelResult.stdout.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
  if (!diagnostic && model !== target.model) {
    throw new B2GateError(
      'TARGET_MODEL_MISMATCH',
      `${device.role} model does not match the fixed B2 target`
    );
  }
  const installedVersion = parseInstalledVersion(packageDumpResult.stdout, device.role);
  if (
    installedVersion.versionCode !== target.versionCode ||
    installedVersion.versionName !== target.versionName
  ) {
    throw new B2GateError(
      'APP_VERSION_MISMATCH',
      `${device.role} Advanced app version does not match the certified target`
    );
  }
  const installedApkPath = parseInstalledApkPath(
    packagePathResult.stdout,
    device.role
  );
  const installedApkSha256 = parseInstalledApkSha256(
    (
      await runAdb(options, device.serial, [
        'shell',
        'sha256sum',
        installedApkPath
      ])
    ).stdout,
    device.role
  );
  if (installedApkSha256 !== target.sha256) {
    throw new B2GateError(
      'APK_SHA256_MISMATCH',
      `${device.role} installed APK does not match the certified artifact`
    );
  }
  const result = {
    role: device.role,
    androidApi,
    currentAndroidUserVerified: true,
    expectedSerialVerified: !diagnostic,
    expectedModelVerified: model === target.model,
    expectedPackageVerified: true,
    expectedAppVersionVerified: true,
    expectedApkSha256Verified: true,
    expectedNodeKindBinding: 'REQUIRES_CONTROLLER_CAPTURE_CORRELATION',
    bluetoothLeFeature: true,
    bluetoothEnabled: true,
    currentUserBluetoothPermissionsGranted: true,
    appInstalled: true,
    appPrivateStatusReadableWithRunAs: true,
    fullNodeCapabilityGate: 'VERIFIED_DURING_EACH_CYCLE'
  };
  if (diagnostic) {
    result.certificationRole = 'handheld';
    result.formalCertificationEligible = false;
    result.expectedNodeKindBinding = 'NON_GATE_ANONYMOUS_ONLY';
  }
  return result;
}

async function forceStop(options, device) {
  await runAdb(options, device.serial, [
    'shell',
    'am',
    'force-stop',
    '--user',
    String(device.userId),
    device.packageId
  ]);
}

async function assertCurrentUserUnchanged(options, device) {
  const result = await runAdb(options, device.serial, [
    'shell',
    'am',
    'get-current-user'
  ]);
  if (parseCurrentUser(result.stdout, device.role) !== device.userId) {
    throw new B2GateError(
      'ANDROID_USER_CHANGED',
      `${device.role} current Android user changed during the gate`
    );
  }
}

async function resetDevice(options, device) {
  await forceStop(options, device);
  await runAdb(
    options,
    device.serial,
    buildCurrentUserRunAsArgs(
      device.packageId,
      device.userId,
      'rm',
      '-f',
      STATUS_PATH,
      `${STATUS_PATH}.bak`,
      `${STATUS_PATH}.new`
    )
  );
}

async function launchDevice(options, device) {
  const result = await runAdb(options, device.serial, [
    'shell',
    'monkey',
    '-p',
    device.packageId,
    '-c',
    'android.intent.category.LAUNCHER',
    '1'
  ]);
  if (!result.stdout.includes('Events injected: 1')) {
    throw new B2GateError('APP_LAUNCH_FAILED', `${device.role} launcher did not start`);
  }
}

async function readStatus(options, device) {
  try {
    return await parseStatusWithBoundedSyntaxRetry(async () => {
      try {
        const result = await runAdb(
          options,
          device.serial,
          buildCurrentUserRunAsArgs(
            device.packageId,
            device.userId,
            'cat',
            STATUS_PATH
          )
        );
        return statusPayloadFromCommandResult(result);
      } catch (error) {
        if (
          error instanceof B2GateError &&
          error.code === 'COMMAND_FAILED' &&
          isExactMissingStatusLine(error.message)
        ) {
          return null;
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof B2GateError) {
      throw new B2GateError(error.code, error.message, {
        fatal: error.fatal,
        lastStatuses: error.lastStatuses,
        detailCode: error.detailCode,
        failedRole: device.role
      });
    }
    throw error;
  }
}

async function readDeviceEpochFloor(options, device) {
  const result = await runAdb(options, device.serial, [
    'shell',
    'date',
    '+%s'
  ]);
  const seconds = result.stdout.trim();
  if (!/^(0|[1-9]\d*)$/.test(seconds)) {
    throw new B2GateError(
      'DEVICE_CLOCK_INVALID',
      `${device.role} device clock is invalid`
    );
  }
  const epochFloorMs = Number(seconds) * 1_000;
  if (!Number.isSafeInteger(epochFloorMs) || epochFloorMs <= 0) {
    throw new B2GateError(
      'DEVICE_CLOCK_INVALID',
      `${device.role} device clock is invalid`
    );
  }
  return {
    epochFloorMs,
    capturedAtPerformanceMs: performance.now()
  };
}

function validateFreshSequence(status, tracker, epochFloorMs, elapsedMs, role) {
  if (
    status.reporterStartedAtEpochMs < epochFloorMs ||
    status.sampledAtEpochMs < status.reporterStartedAtEpochMs ||
    status.sampledAtEpochMs >
      epochFloorMs + elapsedMs + DEVICE_CLOCK_TOLERANCE_MS
  ) {
    throw new B2GateError(
      'STATUS_NOT_FRESH',
      `${role} diagnostic sample is outside the current launch window`,
      { failedRole: role }
    );
  }
  const fingerprint = JSON.stringify(status);
  if (tracker.lastSequence === null) {
    tracker.reporterStartedAtEpochMs = status.reporterStartedAtEpochMs;
    tracker.lastSequence = status.sampleSequence;
    tracker.lastSampledAtEpochMs = status.sampledAtEpochMs;
    tracker.lastFingerprint = fingerprint;
    tracker.distinctSamples = 1;
    return;
  }
  if (status.reporterStartedAtEpochMs !== tracker.reporterStartedAtEpochMs) {
    throw new B2GateError(
      'STATUS_REPORTER_RESTARTED',
      `${role} diagnostic reporter restarted during the cycle`,
      { failedRole: role }
    );
  }
  if (status.sampleSequence < tracker.lastSequence) {
    throw new B2GateError(
      'STATUS_SEQUENCE_REGRESSED',
      `${role} diagnostic sample sequence regressed`,
      { failedRole: role }
    );
  }
  if (status.sampleSequence === tracker.lastSequence) {
    if (
      status.sampledAtEpochMs !== tracker.lastSampledAtEpochMs ||
      fingerprint !== tracker.lastFingerprint
    ) {
      throw new B2GateError(
        'STATUS_SEQUENCE_REUSED',
        `${role} diagnostic content changed without a sequence increment`,
        { failedRole: role }
      );
    }
    return;
  }
  if (status.sampledAtEpochMs <= tracker.lastSampledAtEpochMs) {
    throw new B2GateError(
      'STATUS_TIMESTAMP_REGRESSED',
      `${role} diagnostic timestamp did not increase with its sequence`,
      { failedRole: role }
    );
  }
  tracker.lastSequence = status.sampleSequence;
  tracker.lastSampledAtEpochMs = status.sampledAtEpochMs;
  tracker.lastFingerprint = fingerprint;
  tracker.distinctSamples += 1;
}

function assertOperationalMetrics(status, role) {
  for (const key of CRITICAL_ZERO_METRICS) {
    if (status.metrics[key] !== 0) {
      throw new B2GateError(
        'RADIO_METRICS_FAILED',
        `${role} reported a critical radio failure or drop`,
        { failedRole: role }
      );
    }
  }
  for (const key of CRITICAL_ZERO_PEER_DIRECTORY_METRICS) {
    if (status.metrics.peerDirectory[key] !== 0) {
      throw new B2GateError(
        'PEER_DIRECTORY_METRICS_FAILED',
        `${role} reported a critical peer-directory rejection or drop`,
        { failedRole: role }
      );
    }
  }
  if (status.metrics.scanWindowsCompleted > status.metrics.scanWindowsStarted) {
    throw new B2GateError(
      'RADIO_METRICS_INCONSISTENT',
      `${role} scan window counters are inconsistent`,
      { failedRole: role }
    );
  }
  const peerDirectory = status.metrics.peerDirectory;
  if (
    peerDirectory.added !== peerDirectory.newStreamsAccepted ||
    peerDirectory.newStreamAttempts < peerDirectory.newStreamsAccepted ||
    peerDirectory.newStreamAttemptWindowsStarted >
      peerDirectory.newStreamAttempts ||
    peerDirectory.expired + peerDirectory.capacityEvicted >
      peerDirectory.added ||
    peerDirectory.capacityHighWatermark > 1_024
  ) {
    throw new B2GateError(
      'PEER_DIRECTORY_METRICS_INCONSISTENT',
      `${role} peer-presence counters are inconsistent`,
      { failedRole: role }
    );
  }
}

function hasOperationalAnonymousPeerEvidence(status, tracker) {
  return (
    status.readiness === 'READY' &&
    status.ready &&
    status.radioActive &&
    tracker.distinctSamples >= REQUIRED_DISTINCT_SAMPLES &&
    status.metrics.scanWindowsStarted > 0 &&
    status.metrics.advertisementsStarted > 0 &&
    status.activePeerCount > 0 &&
    status.metrics.acceptedObservations > 0 &&
    status.metrics.firstObservationOffsetP95Ms !== null &&
    status.metrics.firstObservationOffsetP95Ms <= B2_P95_LIMIT_MS
  );
}

function terminalReadinessPersistedBeyondGrace(elapsedMs, terminalSamples) {
  return (
    elapsedMs >= TERMINAL_READINESS_GRACE_MS &&
    terminalSamples >= TERMINAL_READINESS_MIN_SAMPLES
  );
}

function compactPeerDirectoryMetrics(status) {
  return Object.fromEntries(
    PEER_DIRECTORY_KEYS.map((key) => [
      key,
      status?.metrics?.peerDirectory?.[key] ?? 0
    ])
  );
}

function compactDeviceCycle(
  device,
  {
    launchCommandCompletedMs = null,
    statusFirstReadableMs = null,
    readyMs = null,
    observedMs = null,
    firstScanWindowMs = null,
    firstAdvertisementStartedMs = null
  },
  status,
  tracker
) {
  return {
    role: device.role,
    reporterLifecyclePolicy: 'EXPECTED_RESTART_AT_CYCLE_BOUNDARY_ONLY',
    reporterInstanceFreshForCycle: (tracker?.distinctSamples ?? 0) > 0,
    withinCycleReporterRestartDetected: false,
    launchCommandCompletedMs,
    statusFirstReadableMs,
    readyMs,
    firstAnonymousPeerPresenceMs: observedMs,
    firstScanWindowMs,
    firstAdvertisementStartedMs,
    freshDistinctSamples: tracker?.distinctSamples ?? 0,
    sampleSequenceIncreased:
      (tracker?.distinctSamples ?? 0) >= REQUIRED_DISTINCT_SAMPLES,
    lastSampleSequence: tracker?.lastSequence ?? status?.sampleSequence ?? null,
    lastSampleObservedAtCycleMs:
      tracker?.lastSampleObservedAtCycleMs ?? null,
    lastSampleObservationAgeMs:
      tracker?.lastSampleObservationAgeMs ?? null,
    readiness: status?.readiness ?? 'NO_STATUS',
    ready: status?.ready ?? false,
    radioActive: status?.radioActive ?? false,
    scanProfile: status?.scanProfile ?? 'UNKNOWN',
    activePeerCount: status?.activePeerCount ?? 0,
    acceptedObservations: status?.metrics?.acceptedObservations ?? 0,
    scanWindowsStarted: status?.metrics?.scanWindowsStarted ?? 0,
    concurrentScanAdvertiseWindowsStarted:
      status?.metrics?.concurrentScanAdvertiseWindowsStarted ?? 0,
    scanWindowsCompleted: status?.metrics?.scanWindowsCompleted ?? 0,
    advertisementsStarted: status?.metrics?.advertisementsStarted ?? 0,
    advertisementUpdates: status?.metrics?.advertisementUpdates ?? 0,
    scanFailures: status?.metrics?.scanFailures ?? 0,
    advertisementFailures: status?.metrics?.advertisementFailures ?? 0,
    scanIngressDropped: status?.metrics?.scanIngressDropped ?? 0,
    invalidPayloads: status?.metrics?.invalidPayloads ?? 0,
    peerExpiryCount: status?.metrics?.peerExpiryCount ?? 0,
    peerDirectory: compactPeerDirectoryMetrics(status),
    localFirstObservationOffsetP95Ms:
      status?.metrics?.firstObservationOffsetP95Ms ?? null
  };
}

function compactCycleDevices(
  devices,
  statuses,
  trackers,
  launchCompletedAt,
  statusFirstReadableAt,
  readyAt,
  observedAt,
  scanStartedAt,
  advertisementStartedAt
) {
  return devices.map((device, index) =>
    compactDeviceCycle(
      device,
      {
        launchCommandCompletedMs: launchCompletedAt.get(device.role) ?? null,
        statusFirstReadableMs: statusFirstReadableAt.get(device.role) ?? null,
        readyMs: readyAt.get(device.role) ?? null,
        observedMs: observedAt.get(device.role) ?? null,
        firstScanWindowMs: scanStartedAt.get(device.role) ?? null,
        firstAdvertisementStartedMs:
          advertisementStartedAt.get(device.role) ?? null
      },
      statuses[index],
      trackers[index]
    )
  );
}

function applyLifecycleFailureTelemetry(deviceTelemetry, error) {
  return deviceTelemetry.map((device) => {
    if (device.role !== error.failedRole) return device;
    if (error.code === 'STATUS_REPORTER_RESTARTED') {
      return {
        ...device,
        reporterInstanceFreshForCycle: false,
        withinCycleReporterRestartDetected: true
      };
    }
    if (
      error.code === 'STATUS_NOT_FRESH' ||
      error.code === 'REPORTER_BOUNDARY_RESTART_INVALID'
    ) {
      return {
        ...device,
        reporterInstanceFreshForCycle: false
      };
    }
    return device;
  });
}

function inferAnonymousPeerPresenceTimeoutRole(deviceTelemetry) {
  assert.equal(
    deviceTelemetry.length,
    2,
    'peer-presence timeout attribution requires exactly two devices'
  );
  const missingRoles = deviceTelemetry
    .filter((device) => device.firstAnonymousPeerPresenceMs === null)
    .map((device) => device.role);
  assert.ok(
    missingRoles.length > 0,
    'peer-presence timeout must have at least one unobserved device'
  );
  return missingRoles.length === deviceTelemetry.length
    ? 'both'
    : missingRoles[0];
}

async function runCycle(
  options,
  devices,
  cycleNumber,
  previousReporterStarts
) {
  await Promise.all(
    devices.map((device) => assertCurrentUserUnchanged(options, device))
  );
  await Promise.all(devices.map((device) => resetDevice(options, device)));
  const clockAnchors = await Promise.all(
    devices.map((device) => readDeviceEpochFloor(options, device))
  );
  const startedAt = performance.now();
  const launchCompletedAt = new Map();
  await Promise.all(
    devices.map(async (device) => {
      await launchDevice(options, device);
      launchCompletedAt.set(
        device.role,
        Math.round(performance.now() - startedAt)
      );
    })
  );
  const statusFirstReadableAt = new Map();
  const readyAt = new Map();
  const observedAt = new Map();
  const scanStartedAt = new Map();
  const advertisementStartedAt = new Map();
  const trackers = devices.map(() => ({
    reporterStartedAtEpochMs: null,
    lastSequence: null,
    lastSampledAtEpochMs: null,
    lastFingerprint: null,
    distinctSamples: 0,
    lastSampleObservedAtCycleMs: null,
    lastSampleObservationAgeMs: null
  }));
  let lastStatuses = devices.map(() => null);
  let lastHarnessObservationPendingVerifiedMs = null;
  let terminalSignature = null;
  let terminalSamples = 0;

  while (performance.now() - startedAt <= options.timeoutMs) {
    const statusReads = await Promise.allSettled(
      devices.map((device) => readStatus(options, device))
    );
    const statuses = statusReads.map((result) =>
      result.status === 'fulfilled' ? result.value : null
    );
    const failedRead = statusReads.find((result) => result.status === 'rejected');
    if (failedRead) {
      const error = failedRead.reason;
      if (!(error instanceof B2GateError)) throw error;
      throw new B2GateError(error.code, error.message, {
        fatal: error.fatal,
        lastStatuses: statuses.map(
          (status, index) => status ?? lastStatuses[index] ?? null
        ),
        cycleDevices: compactCycleDevices(
          devices,
          statuses.map((status, index) => status ?? lastStatuses[index] ?? null),
          trackers,
          launchCompletedAt,
          statusFirstReadableAt,
          readyAt,
          observedAt,
          scanStartedAt,
          advertisementStartedAt
        ),
        cycleElapsedMs: Math.round(performance.now() - startedAt),
        detailCode: error.detailCode,
        failedRole: error.failedRole
      });
    }
    lastStatuses = statuses;
    const polledAtPerformanceMs = performance.now();
    const elapsedMs = Math.round(polledAtPerformanceMs - startedAt);
    try {
      statuses.forEach((status, index) => {
        if (!status) return;
        const device = devices[index];
        const role = device.role;
        const tracker = trackers[index];
        if (!statusFirstReadableAt.has(role)) {
          statusFirstReadableAt.set(role, elapsedMs);
        }
        const deviceElapsedMs = Math.round(
          polledAtPerformanceMs -
            clockAnchors[index].capturedAtPerformanceMs
        );
        const previousSequence = tracker.lastSequence;
        validateFreshSequence(
          status,
          tracker,
          clockAnchors[index].epochFloorMs,
          deviceElapsedMs,
          role
        );
        if (tracker.lastSequence !== previousSequence) {
          tracker.lastSampleObservedAtCycleMs = elapsedMs;
        }
        tracker.lastSampleObservationAgeMs =
          tracker.lastSampleObservedAtCycleMs === null
            ? null
            : elapsedMs - tracker.lastSampleObservedAtCycleMs;
        assertOperationalMetrics(status, role);
        if (status.ready && !readyAt.has(role)) readyAt.set(role, elapsedMs);
        if (
          status.metrics.scanWindowsStarted > 0 &&
          !scanStartedAt.has(role)
        ) {
          scanStartedAt.set(role, elapsedMs);
        }
        if (
          status.metrics.advertisementsStarted > 0 &&
          !advertisementStartedAt.has(role)
        ) {
          advertisementStartedAt.set(role, elapsedMs);
        }
        if (
          hasOperationalAnonymousPeerEvidence(status, tracker) &&
          !observedAt.has(role)
        ) {
          observedAt.set(role, elapsedMs);
        }
      });
    } catch (error) {
      if (!(error instanceof B2GateError)) throw error;
      const failedCycleDevices = applyLifecycleFailureTelemetry(
        compactCycleDevices(
          devices,
          statuses,
          trackers,
          launchCompletedAt,
          statusFirstReadableAt,
          readyAt,
          observedAt,
          scanStartedAt,
          advertisementStartedAt
        ),
        error
      );
      throw new B2GateError(error.code, error.message, {
        fatal: error.fatal,
        lastStatuses: statuses,
        cycleDevices: failedCycleDevices,
        cycleElapsedMs: elapsedMs,
        detailCode: error.detailCode,
        failedRole: error.failedRole
      });
    }

    if (
      statuses.every((status) => status !== null) &&
      !devices.every((device) => observedAt.has(device.role))
    ) {
      lastHarnessObservationPendingVerifiedMs = elapsedMs;
    }

    if (devices.every((device) => observedAt.has(device.role))) {
      const deviceTelemetry = compactCycleDevices(
        devices,
        statuses,
        trackers,
        launchCompletedAt,
        statusFirstReadableAt,
        readyAt,
        observedAt,
        scanStartedAt,
        advertisementStartedAt
      );
      devices.forEach((device, index) => {
        const reporterStartedAtEpochMs = trackers[index].reporterStartedAtEpochMs;
        const previous = previousReporterStarts.get(device.role);
        if (
          previous !== undefined &&
          reporterStartedAtEpochMs <= previous
        ) {
          throw new B2GateError(
            'REPORTER_BOUNDARY_RESTART_INVALID',
            `${device.role} reporter instance did not rotate at the cycle boundary`,
            {
              lastStatuses: statuses,
              cycleDevices: applyLifecycleFailureTelemetry(
                deviceTelemetry,
                {
                  code: 'REPORTER_BOUNDARY_RESTART_INVALID',
                  failedRole: device.role
                }
              ),
              cycleElapsedMs: elapsedMs,
              failedRole: device.role
            }
          );
        }
        previousReporterStarts.set(device.role, reporterStartedAtEpochMs);
      });
      const anonymousPeerPresenceMs = Math.max(...observedAt.values());
      return {
        cycle: cycleNumber,
        outcome: 'PASS',
        evidenceOrigin: 'LIVE_ADB_PRIVATE_STATUS',
        anonymousPeerPresenceMs,
        ...compactCycleTiming(
          deviceTelemetry,
          anonymousPeerPresenceMs,
          false,
          options.timeoutMs
        ),
        devices: deviceTelemetry
      };
    }

    const terminal = statuses.map((status) =>
      status && TERMINAL_READINESS.has(status.readiness) ? status.readiness : null
    );
    const signature = terminal.some(Boolean) ? terminal.join('|') : null;
    if (signature && signature === terminalSignature) {
      terminalSamples += 1;
    } else {
      terminalSignature = signature;
      terminalSamples = signature ? 1 : 0;
    }
    if (terminalReadinessPersistedBeyondGrace(elapsedMs, terminalSamples)) {
      throw new B2GateError(
        'RUNTIME_CAPABILITY_GATE_FAILED',
        'a Lab app did not reach the FULL_NODE discovery readiness gate',
        {
          lastStatuses: statuses,
          cycleDevices: compactCycleDevices(
            devices,
            statuses,
            trackers,
            launchCompletedAt,
            statusFirstReadableAt,
            readyAt,
            observedAt,
            scanStartedAt,
            advertisementStartedAt
          ),
          cycleElapsedMs: elapsedMs
        }
      );
    }
    if (elapsedMs >= 5_000 && statuses.every((status) => status == null)) {
      throw new B2GateError(
        'LAB_STATUS_UNAVAILABLE',
        'Lab diagnostic status is unavailable; verify Lab, diagnostics and discovery flags',
        {
          lastStatuses: statuses,
          cycleDevices: compactCycleDevices(
            devices,
            statuses,
            trackers,
            launchCompletedAt,
            statusFirstReadableAt,
            readyAt,
            observedAt,
            scanStartedAt,
            advertisementStartedAt
          ),
          cycleElapsedMs: elapsedMs
        }
      );
    }
    await sleep(options.pollMs);
  }

  const timeoutCycleDevices = compactCycleDevices(
    devices,
    lastStatuses,
    trackers,
    launchCompletedAt,
    statusFirstReadableAt,
    readyAt,
    observedAt,
    scanStartedAt,
    advertisementStartedAt
  );
  throw new B2GateError(
    'ANONYMOUS_PEER_PRESENCE_TIMEOUT',
    `cycle ${cycleNumber} exceeded the peer-presence timeout`,
    {
      fatal: false,
      lastStatuses,
      cycleDevices: timeoutCycleDevices,
      cycleElapsedMs: Math.round(performance.now() - startedAt),
      harnessObservationCensorAtMs:
        lastHarnessObservationPendingVerifiedMs,
      failedRole: inferAnonymousPeerPresenceTimeoutRole(timeoutCycleDevices)
    }
  );
}

function compactFailureStatus(devices, statuses) {
  return devices.map((device, index) =>
    compactDeviceCycle(device, {}, statuses[index], null)
  );
}

function compactFailureDetail(error, devices) {
  const detail = {};
  if (
    typeof error.detailCode === 'string' &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(error.detailCode)
  ) {
    detail.reasonDetailCode = error.detailCode;
  }
  if (
    typeof error.failedRole === 'string' &&
    ((error.code === 'ANONYMOUS_PEER_PRESENCE_TIMEOUT' &&
      error.failedRole === 'both') ||
      devices.some((device) => device.role === error.failedRole))
  ) {
    detail.reasonRole = error.failedRole;
  }
  return detail;
}

function compactCycleTiming(
  deviceTelemetry,
  elapsedMs,
  timeoutCensored,
  timeoutMs,
  harnessObservationCensorAtMs = null
) {
  const readyValues = deviceTelemetry.map((device) => device.readyMs);
  const observedValues = deviceTelemetry.map(
    (device) => device.firstAnonymousPeerPresenceMs
  );
  const bothReadyMs = readyValues.every(Number.isSafeInteger)
    ? Math.max(...readyValues)
    : null;
  const bothObservedMs = observedValues.every(Number.isSafeInteger)
    ? Math.max(...observedValues)
    : null;
  return {
    elapsedMs: Number.isSafeInteger(elapsedMs) ? elapsedMs : null,
    timeoutCensored,
    timeoutMs,
    harnessObservationCensorAtMs:
      timeoutCensored && Number.isSafeInteger(harnessObservationCensorAtMs)
        ? harnessObservationCensorAtMs
        : null,
    bothReadyMs,
    peerPresenceAfterBothReadyMs:
      bothReadyMs !== null && bothObservedMs !== null
        ? Math.max(0, bothObservedMs - bothReadyMs)
        : null
  };
}

function buildLatencyAccounting(options, cycles) {
  const timeoutCycles = cycles.filter(
    (cycle) =>
      cycle.outcome !== 'PASS' &&
      cycle.reasonCode === 'ANONYMOUS_PEER_PRESENCE_TIMEOUT'
  );
  const lowerBoundSamples = cycles.map((cycle) => {
    if (cycle.outcome === 'PASS') return cycle.anonymousPeerPresenceMs;
    if (
      cycle.reasonCode === 'ANONYMOUS_PEER_PRESENCE_TIMEOUT' &&
      Number.isSafeInteger(cycle.harnessObservationCensorAtMs)
    ) {
      return cycle.harnessObservationCensorAtMs;
    }
    return null;
  });
  const allCyclesHaveLatencyLowerBound = lowerBoundSamples.every(
    Number.isSafeInteger
  );
  const postReadySamples = cycles
    .filter((cycle) => cycle.outcome === 'PASS')
    .map((cycle) => cycle.peerPresenceAfterBothReadyMs)
    .filter(Number.isSafeInteger);
  return {
    p95Population: 'PASS_CYCLES_ONLY',
    censoredCycleCount: timeoutCycles.length,
    allCycleHarnessObservationP95LowerBoundMs:
      allCyclesHaveLatencyLowerBound
      ? nearestRankP95(lowerBoundSamples)
      : null,
    peerPresenceAfterBothReadyP95Ms:
      postReadySamples.length > 0 ? nearestRankP95(postReadySamples) : null,
    timeoutsCountAsFailures: true
  };
}

function hasCompleteMeasuredQuiescence(
  quiescenceIntervals,
  { requiredCycles, configuredMs, minimumMs }
) {
  return (
    Array.isArray(quiescenceIntervals) &&
    quiescenceIntervals.length === requiredCycles &&
    Number.isSafeInteger(configuredMs) &&
    configuredMs >= minimumMs &&
    quiescenceIntervals.every(
      (interval, index) =>
        interval !== null &&
        typeof interval === 'object' &&
        interval.phase === (index === 0 ? 'INITIAL' : 'INTER_CYCLE') &&
        interval.afterCycle === (index === 0 ? null : index) &&
        interval.beforeCycle === index + 1 &&
        interval.requestedMs === configuredMs &&
        Number.isSafeInteger(interval.observedMs) &&
        interval.observedMs >= interval.requestedMs &&
        interval.clock === 'HOST_MONOTONIC' &&
        interval.startsAfterBothForceStops === true
    )
  );
}

function buildTimingConfiguration(options) {
  if (options.diagnosticCooldownPilot === true) {
    return {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      cycleGapMs: null,
      quiescenceMs: options.quiescenceMs,
      quiescenceClock: 'HOST_MONOTONIC',
      quiescenceStartsAfterBothForceStops: true,
      requiredMinimumQuiescenceMs: COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
      latencyClockOrigin: 'CYCLE_LAUNCH',
      requiredMaximumP95Ms: B2_P95_LIMIT_MS
    };
  }
  if (options.diagnosticHandheldPair !== true) {
    return {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      cycleGapMs: null,
      quiescenceMs:
        options.formalQuiescenceMs ?? FORMAL_MIN_QUIESCENCE_MS,
      quiescenceClock: 'HOST_MONOTONIC',
      quiescenceStartsAfterBothForceStops: true,
      requiredMinimumQuiescenceMs: FORMAL_MIN_QUIESCENCE_MS,
      requiredQuiescenceWindows: DEFAULT_CYCLES,
      latencyClockOrigin: 'CYCLE_LAUNCH',
      requiredMaximumP95Ms: B2_P95_LIMIT_MS
    };
  }
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    cycleGapMs: options.cycleGapMs ?? DEFAULT_CYCLE_GAP_MS,
    latencyClockOrigin: 'CYCLE_LAUNCH',
    requiredMaximumP95Ms: B2_P95_LIMIT_MS
  };
}

function hasCompleteTargetPreflight(preflight) {
  if (!Array.isArray(preflight) || preflight.length !== 2) return false;
  return ['handheld', 'station'].every((role) => {
    const matches = preflight.filter((device) => device?.role === role);
    if (matches.length !== 1) return false;
    const device = matches[0];
    return (
      device.currentAndroidUserVerified === true &&
      device.expectedSerialVerified === true &&
      device.expectedModelVerified === true &&
      device.expectedPackageVerified === true &&
      device.expectedAppVersionVerified === true &&
      device.expectedApkSha256Verified === true &&
      device.currentUserBluetoothPermissionsGranted === true &&
      device.fullNodeCapabilityGate === 'VERIFIED_DURING_EACH_CYCLE'
    );
  });
}

function hasCompleteDiagnosticPreflight(preflight) {
  if (!Array.isArray(preflight) || preflight.length !== 2) return false;
  return ['handheld_a', 'handheld_b'].every((role) => {
    const matches = preflight.filter((device) => device?.role === role);
    if (matches.length !== 1) return false;
    const device = matches[0];
    return (
      device.certificationRole === 'handheld' &&
      device.formalCertificationEligible === false &&
      device.currentAndroidUserVerified === true &&
      device.expectedSerialVerified === false &&
      device.expectedPackageVerified === true &&
      device.expectedAppVersionVerified === true &&
      device.expectedApkSha256Verified === true &&
      device.currentUserBluetoothPermissionsGranted === true &&
      device.fullNodeCapabilityGate === 'VERIFIED_DURING_EACH_CYCLE'
    );
  });
}

function buildDiagnosticSummary(
  options,
  preflight,
  cycles,
  stoppedEarly,
  quiescenceIntervals = []
) {
  const cooldownPilot = options.diagnosticCooldownPilot === true;
  const requiredCycles = cooldownPilot
    ? COOLDOWN_PILOT_CYCLES
    : DEFAULT_CYCLES;
  const passedCycles = cycles.filter((cycle) => cycle.outcome === 'PASS');
  const failedCycles = cycles.filter((cycle) => cycle.outcome !== 'PASS');
  const anonymousPeerPresenceP95Ms = nearestRankP95(
    passedCycles.map((cycle) => cycle.anonymousPeerPresenceMs)
  );
  const exactCycleSequence = cycles.every(
    (cycle, index) =>
      cycle.cycle === index + 1 &&
      Number.isSafeInteger(cycle.anonymousPeerPresenceMs) &&
      cycle.anonymousPeerPresenceMs >= 0
  );
  const liveCycleEvidenceComplete = cycles.every(
    (cycle) =>
      cycle.evidenceOrigin === 'LIVE_ADB_PRIVATE_STATUS' &&
      cycle.intentionalBoundaryForceStopVerified === true &&
      Array.isArray(cycle.devices) &&
      cycle.devices.length === 2 &&
      cycle.devices.every(
        (device) =>
          device.reporterLifecyclePolicy ===
            'EXPECTED_RESTART_AT_CYCLE_BOUNDARY_ONLY' &&
          device.reporterInstanceFreshForCycle === true &&
          device.withinCycleReporterRestartDetected === false
      )
  );
  const quiescenceEvidenceComplete =
    !cooldownPilot ||
    hasCompleteMeasuredQuiescence(quiescenceIntervals, {
      requiredCycles: COOLDOWN_PILOT_CYCLES,
      configuredMs: options.quiescenceMs,
      minimumMs: COOLDOWN_PILOT_MIN_QUIESCENCE_MS
    });
  const localMeasurementPass =
    !stoppedEarly &&
    options.physicalAdbAccessed === true &&
    options.cycles === requiredCycles &&
    cycles.length === requiredCycles &&
    exactCycleSequence &&
    liveCycleEvidenceComplete &&
    quiescenceEvidenceComplete &&
    failedCycles.length === 0 &&
    hasCompleteDiagnosticPreflight(preflight) &&
    anonymousPeerPresenceP95Ms !== null &&
    anonymousPeerPresenceP95Ms <= B2_P95_LIMIT_MS;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    source: cooldownPilot
      ? 'V6_B2_ANDROID_HANDHELD_PAIR_COOLDOWN_PILOT'
      : 'V6_B2_ANDROID_HANDHELD_PAIR_DIAGNOSTIC',
    certificationMatrixBinding: ADVANCED_CERTIFICATION_TARGETS_BINDING,
    scope: cooldownPilot
      ? 'DIAGNOSTIC_TWO_HANDHELDS_COOLDOWN_PILOT'
      : 'DIAGNOSTIC_TWO_HANDHELDS_DISCOVERY_ONLY',
    mode: cooldownPilot
      ? 'DIAGNOSTIC_COOLDOWN_PILOT'
      : 'DIAGNOSTIC_HANDHELD_PAIR',
    evidenceClass: 'NON_GATE_EVIDENCE',
    generatedAt: new Date().toISOString(),
    gate: 'PENDING',
    gateReason: cooldownPilot
      ? 'COOLDOWN_PILOT_NOT_CERTIFICATION_ELIGIBLE'
      : 'DIAGNOSTIC_TARGET_PAIR_NOT_CERTIFICATION_ELIGIBLE',
    b2PromotionAllowed: false,
    certificationEligible: false,
    formalTargetMappingPreserved: true,
    localMeasurementVerdict: localMeasurementPass ? 'PASS' : 'PENDING',
    measurement: 'TWO_HANDHELDS_ANONYMOUS_PEER_PRESENCE',
    requestedCycles: options.cycles,
    executedCycles: cycles.length,
    passedCycles: passedCycles.length,
    failedCycles: failedCycles.length,
    exactCycleSequence,
    liveCycleEvidenceComplete,
    stoppedEarly,
    anonymousPeerPresenceP95Ms,
    requiredMaximumP95Ms: B2_P95_LIMIT_MS,
    timingConfiguration: buildTimingConfiguration(options),
    latencyAccounting: buildLatencyAccounting(options, cycles),
    formalCertificationCyclesUnaffected: DEFAULT_CYCLES,
    formalCertificationRolesUnaffected: ['handheld', 'station'],
    requiresPreEnrolledIdentity: true,
    stagesEnrollmentQr: false,
    externalEvidenceAcceptedForPromotion: false,
    arbitraryEvidenceFilesAccepted: false,
    evidenceCollection: {
      source: 'LIVE_ADB_PRIVATE_STATUS',
      freshnessCheckedPerCycle: true,
      reporterRestartPolicy: 'EXPECTED_AT_CYCLE_BOUNDARY_ONLY',
      withinCycleReporterRestart: 'INVALIDATES_CYCLE',
      intentionalBoundaryForceStopRequired: true,
      continuousReporterPidRequiredAcrossCycles: false
    },
    physicalCertificationPassEmittedByHarness: false,
    physicalAdbAccessed: options.physicalAdbAccessed === true,
    resultContainsDeviceSerials: false,
    raspberryCommands: false,
    ...(cooldownPilot
      ? {
          pilotVerdict: localMeasurementPass ? 'PASS' : 'PENDING',
          quiescenceEvidenceComplete,
          pilotContract: {
            purpose: 'MEASURE_DISCOVERY_AFTER_FULL_RADIO_COOLDOWN',
            requiredCycles: COOLDOWN_PILOT_CYCLES,
            requiredInitialQuiescenceIntervals: 1,
            requiredInterCycleIntervals: COOLDOWN_PILOT_CYCLES - 1,
            requiredTotalQuiescenceIntervals: COOLDOWN_PILOT_CYCLES,
            configuredQuiescenceMs: options.quiescenceMs,
            requiredMinimumQuiescenceMs:
              COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
            fixedCycleCountCannotSatisfyFormalB2: true,
            promotionProhibited: true
          },
          quiescenceIntervals
        }
      : {}),
    devices: preflight,
    cycles
  };
}

function buildSummary(
  options,
  preflight,
  cycles,
  stoppedEarly,
  quiescenceIntervals = []
) {
  const passedCycles = cycles.filter((cycle) => cycle.outcome === 'PASS');
  const failedCycles = cycles.filter((cycle) => cycle.outcome !== 'PASS');
  const latencies = passedCycles.map((cycle) => cycle.anonymousPeerPresenceMs);
  const anonymousPeerPresenceP95Ms = nearestRankP95(latencies);
  const exactCycleSequence = cycles.every(
    (cycle, index) =>
      cycle.cycle === index + 1 &&
      Number.isSafeInteger(cycle.anonymousPeerPresenceMs) &&
      cycle.anonymousPeerPresenceMs >= 0
  );
  const configuredFormalQuiescenceMs =
    options.formalQuiescenceMs ?? FORMAL_MIN_QUIESCENCE_MS;
  const formalQuiescenceEvidenceComplete = hasCompleteMeasuredQuiescence(
    quiescenceIntervals,
    {
      requiredCycles: DEFAULT_CYCLES,
      configuredMs: configuredFormalQuiescenceMs,
      minimumMs: FORMAL_MIN_QUIESCENCE_MS
    }
  );
  const measurementPass =
    !stoppedEarly &&
    options.cycles === DEFAULT_CYCLES &&
    cycles.length === DEFAULT_CYCLES &&
    exactCycleSequence &&
    formalQuiescenceEvidenceComplete &&
    failedCycles.length === 0 &&
    hasCompleteTargetPreflight(preflight) &&
    anonymousPeerPresenceP95Ms !== null &&
    anonymousPeerPresenceP95Ms <= B2_P95_LIMIT_MS;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    source: 'V6_B2_ANDROID_GATE_HARNESS',
    certificationMatrixBinding: ADVANCED_CERTIFICATION_TARGETS_BINDING,
    scope: 'DISCOVERY_ONLY_POST_ENROLLMENT',
    generatedAt: new Date().toISOString(),
    gate: 'PENDING',
    gateReason: !formalQuiescenceEvidenceComplete
      ? 'FORMAL_QUIESCENCE_EVIDENCE_INCOMPLETE'
      : measurementPass
        ? 'EXTERNAL_EVIDENCE_AUTHENTICITY_REVIEW_REQUIRED'
        : 'LOCAL_MEASUREMENT_REQUIREMENTS_NOT_MET',
    localMeasurementVerdict: measurementPass ? 'PASS' : 'PENDING',
    measurement: 'TWO_TARGET_ANONYMOUS_PEER_PRESENCE',
    requestedCycles: options.cycles,
    executedCycles: cycles.length,
    passedCycles: passedCycles.length,
    failedCycles: failedCycles.length,
    exactCycleSequence,
    stoppedEarly,
    formalQuiescenceEvidenceComplete,
    anonymousPeerPresenceP95Ms,
    requiredMaximumP95Ms: B2_P95_LIMIT_MS,
    timingConfiguration: buildTimingConfiguration(options),
    latencyAccounting: buildLatencyAccounting(options, cycles),
    requiredCertificationCycles: DEFAULT_CYCLES,
    formalQuiescenceContract: {
      purpose: 'FORMAL_DISCOVERY_AFTER_FULL_RADIO_COOLDOWN',
      requiredCycles: DEFAULT_CYCLES,
      requiredInitialQuiescenceIntervals: 1,
      requiredInterCycleIntervals: DEFAULT_CYCLES - 1,
      requiredTotalQuiescenceIntervals: DEFAULT_CYCLES,
      configuredQuiescenceMs: configuredFormalQuiescenceMs,
      requiredMinimumQuiescenceMs: FORMAL_MIN_QUIESCENCE_MS,
      clock: 'HOST_MONOTONIC',
      startsAfterBothForceStops: true,
      missingOrShortIntervalFailsClosed: true
    },
    quiescenceIntervals,
    requiresPreEnrolledIdentity: true,
    stagesEnrollmentQr: false,
    raspberryCommands: false,
    externalEvidence: {
      controlledRfEnvironmentProvided: false,
      controllerCaptureProvided: false,
      controlledRfFilePresent: options.rfEvidenceProvided === true,
      controllerCaptureFilePresent: options.captureEvidenceProvided === true,
      authenticityVerifiedByHarness: false,
      arbitraryFilePresenceCannotSatisfyEvidence: true,
      peerIdentityDerivedFromAnonymousPeerCount: false,
      expectedNodeKindsRequireCaptureCorrelation: true,
      evidenceContentRequiresIndependentReview: true,
      independentReviewStatus: 'PENDING'
    },
    physicalCertificationPassEmittedByHarness: false,
    devices: preflight,
    cycles
  };
}

function buildDryRun(options) {
  if (options.diagnosticHandheldPair) {
    const cooldownPilot = options.diagnosticCooldownPilot === true;
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      source: cooldownPilot
        ? 'V6_B2_ANDROID_HANDHELD_PAIR_COOLDOWN_PILOT'
        : 'V6_B2_ANDROID_HANDHELD_PAIR_DIAGNOSTIC',
      certificationMatrixBinding: ADVANCED_CERTIFICATION_TARGETS_BINDING,
      scope: cooldownPilot
        ? 'DIAGNOSTIC_TWO_HANDHELDS_COOLDOWN_PILOT'
        : 'DIAGNOSTIC_TWO_HANDHELDS_DISCOVERY_ONLY',
      mode: cooldownPilot
        ? 'DRY_RUN_DIAGNOSTIC_COOLDOWN_PILOT'
        : 'DRY_RUN_DIAGNOSTIC_HANDHELD_PAIR',
      evidenceClass: 'NON_GATE_EVIDENCE',
      gate: 'NOT_RUN',
      b2PromotionAllowed: false,
      certificationEligible: false,
      formalTargetMappingPreserved: true,
      adbExecuted: false,
      requestedCycles: options.cycles,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      cycleGapMs: cooldownPilot ? null : options.cycleGapMs,
      requiredMaximumP95Ms: B2_P95_LIMIT_MS,
      timingConfiguration: buildTimingConfiguration(options),
      formalCertificationCyclesUnaffected: DEFAULT_CYCLES,
      formalCertificationRolesUnaffected: ['handheld', 'station'],
      requiresPreEnrolledIdentity: true,
      stagesEnrollmentQr: false,
      devices: [
        {
          role: 'handheld_a',
          certificationRole: 'handheld',
          diagnosticSerialConfigured: options.handheldASerial !== null
        },
        {
          role: 'handheld_b',
          certificationRole: 'handheld',
          diagnosticSerialConfigured: options.handheldBSerial !== null
        }
      ],
      checks: [
        'two distinct ADB devices running the fixed Palmare Advanced Lab build',
        `Android API >= ${MIN_ANDROID_API}`,
        'BLE hardware, current-user permissions and FULL_NODE readiness',
        'fresh scan and advertise telemetry with anonymous reciprocal presence',
        ...(cooldownPilot
          ? [
              `exactly ${COOLDOWN_PILOT_CYCLES} cycles, each preceded by measured quiescence >= ${COOLDOWN_PILOT_MIN_QUIESCENCE_MS} ms`
            ]
          : []),
        `diagnostic p95 <= ${B2_P95_LIMIT_MS} ms`,
        'NON_GATE_EVIDENCE cannot satisfy or promote formal B2'
      ],
      externalEvidenceAcceptedForPromotion: false,
      arbitraryEvidenceFilesAccepted: false,
      evidenceCollection: {
        source: 'LIVE_ADB_PRIVATE_STATUS_WHEN_EXECUTED',
        reporterRestartPolicy: 'EXPECTED_AT_CYCLE_BOUNDARY_ONLY',
        withinCycleReporterRestart: 'INVALIDATES_CYCLE',
        intentionalBoundaryForceStopRequired: true,
        continuousReporterPidRequiredAcrossCycles: false
      },
      physicalCertificationPassEmittedByHarness: false,
      physicalAdbAccessed: false,
      resultContainsDeviceSerials: false,
      raspberryCommands: false,
      ...(cooldownPilot
        ? {
            pilotContract: {
              purpose: 'MEASURE_DISCOVERY_AFTER_FULL_RADIO_COOLDOWN',
              requiredCycles: COOLDOWN_PILOT_CYCLES,
              requiredInitialQuiescenceIntervals: 1,
              requiredInterCycleIntervals: COOLDOWN_PILOT_CYCLES - 1,
              requiredTotalQuiescenceIntervals: COOLDOWN_PILOT_CYCLES,
              configuredQuiescenceMs: options.quiescenceMs,
              requiredMinimumQuiescenceMs:
                COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
              fixedCycleCountCannotSatisfyFormalB2: true,
              promotionProhibited: true
            }
          }
        : {})
    };
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    source: 'V6_B2_ANDROID_GATE_HARNESS',
    certificationMatrixBinding: ADVANCED_CERTIFICATION_TARGETS_BINDING,
    scope: 'DISCOVERY_ONLY_POST_ENROLLMENT',
    mode: 'DRY_RUN',
    gate: 'NOT_RUN',
    adbExecuted: false,
    requestedCycles: options.cycles,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    cycleGapMs: null,
    requiredMaximumP95Ms: B2_P95_LIMIT_MS,
    timingConfiguration: buildTimingConfiguration(options),
    formalQuiescenceEvidenceExpected: true,
    formalQuiescenceContract: {
      purpose: 'FORMAL_DISCOVERY_AFTER_FULL_RADIO_COOLDOWN',
      requiredCycles: DEFAULT_CYCLES,
      requiredInitialQuiescenceIntervals: 1,
      requiredInterCycleIntervals: DEFAULT_CYCLES - 1,
      requiredTotalQuiescenceIntervals: DEFAULT_CYCLES,
      configuredQuiescenceMs: options.formalQuiescenceMs,
      requiredMinimumQuiescenceMs: FORMAL_MIN_QUIESCENCE_MS,
      clock: 'HOST_MONOTONIC',
      startsAfterBothForceStops: true,
      missingOrShortIntervalFailsClosed: true
    },
    requiresPreEnrolledIdentity: true,
    stagesEnrollmentQr: false,
    extendedEnrollmentAndCaptureHarness:
      'scripts/run-b2-android-adb-harness.mjs',
    controlledRfPairRequired: true,
    devices: [
      {
        role: 'handheld',
        expectedTargetConfigured:
          options.handheldSerial === EXPECTED_TARGETS.handheld.serial
      },
      {
        role: 'station',
        expectedTargetConfigured:
          options.stationSerial === EXPECTED_TARGETS.station.serial
      }
    ],
    checks: [
      'ADB device authorization and distinct serial selection',
      `Android API >= ${MIN_ANDROID_API}`,
      'BLE hardware feature and enabled adapter',
      'fixed Advanced package, model, version and node-role binding',
      'run-as access for the current Android user',
      'scan, advertise and connect grants for the current Android user only',
      'Lab reporter readiness exactly READY (FULL_NODE)',
      'fresh status window with increasing sample sequence',
      'active radio, scan and advertise activity with zero critical failure/drop counters',
      'anonymous peer presence on both devices; identity requires external capture',
      `exactly ${DEFAULT_CYCLES} measured quiescence windows >= ${FORMAL_MIN_QUIESCENCE_MS} ms, one before every cycle`,
      `exactly ${DEFAULT_CYCLES} cycles and anonymous-presence p95 <= ${B2_P95_LIMIT_MS} ms`,
      'non-empty controlled-RF and controller-capture evidence files'
    ],
    externalEvidenceRequired: true,
    peerIdentityDerivedFromAnonymousPeerCount: false,
    statusPath: STATUS_PATH,
    resultContainsDeviceSerials: false,
    raspberryCommands: false
  };
}

function statusFixture() {
  const peerDirectory = Object.fromEntries(PEER_DIRECTORY_KEYS.map((key) => [key, 0]));
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((key) => {
      if (key === 'peerDirectory') return [key, peerDirectory];
      if (key === 'firstObservationOffsetP95Ms') return [key, null];
      return [key, 0];
    })
  );
  return {
    schemaVersion: 1,
    source: 'V6_ANDROID_DISCOVERY_LAB',
    labBuild: true,
    diagnosticsEnabled: true,
    sampleSequence: 1,
    sampledAtEpochMs: 1_100,
    reporterStartedAtEpochMs: 1_000,
    readiness: 'READY',
    ready: true,
    radioActive: true,
    scanProfile: 'STABLE',
    activePeerCount: 1,
    metrics
  };
}

async function runSelfTest() {
  let tests = 0;
  const check = (callback) => {
    callback();
    tests += 1;
  };
  check(() => {
    const parsed = parseStatus(JSON.stringify(statusFixture()));
    assert.equal(parsed.readiness, 'READY');
  });
  const transientPayloads = [
    '{"schemaVersion":1',
    JSON.stringify(statusFixture())
  ];
  let transientReads = 0;
  let transientWaits = 0;
  const recoveredStatus = await parseStatusWithBoundedSyntaxRetry(
    async () => {
      transientReads += 1;
      return transientPayloads.shift();
    },
    {
      attempts: 3,
      retryDelayMs: 1,
      sleepFn: async () => {
        transientWaits += 1;
      }
    }
  );
  check(() => assert.equal(recoveredStatus.readiness, 'READY'));
  check(() => assert.equal(transientReads, 2));
  check(() => assert.equal(transientWaits, 1));
  let persistentReads = 0;
  let persistentError = null;
  try {
    await parseStatusWithBoundedSyntaxRetry(
      async () => {
        persistentReads += 1;
        return '{"schemaVersion":1';
      },
      { attempts: 3, retryDelayMs: 1, sleepFn: async () => undefined }
    );
  } catch (error) {
    persistentError = error;
  }
  check(() => assert.equal(persistentReads, 3));
  check(() => assert.equal(persistentError?.code, 'STATUS_INVALID'));
  check(() =>
    assert.equal(
      persistentError?.detailCode,
      'JSON_SYNTAX_INVALID_PERSISTENT'
    )
  );
  let schemaReads = 0;
  let schemaError = null;
  try {
    await parseStatusWithBoundedSyntaxRetry(async () => {
      schemaReads += 1;
      return JSON.stringify({ ...statusFixture(), unexpected: true });
    });
  } catch (error) {
    schemaError = error;
  }
  check(() => assert.equal(schemaReads, 1));
  check(() => assert.equal(schemaError?.code, 'STATUS_INVALID'));
  check(() => assert.equal(schemaError?.detailCode, 'STATUS_FIELDS_INVALID'));
  check(() =>
    assert.equal(
      statusPayloadFromCommandResult({
        stdout: `${STATUS_MISSING_LINE}\n`,
        stderr: ''
      }),
      null
    )
  );
  check(() =>
    assert.equal(
      statusPayloadFromCommandResult({
        stdout: '',
        stderr: `${STATUS_MISSING_LINE}\n`
      }),
      null
    )
  );
  check(() =>
    assert.throws(
      () =>
        statusPayloadFromCommandResult({
          stdout: `${STATUS_MISSING_LINE}\n`,
          stderr: 'unexpected\n'
        }),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'STATUS_READ_FAILED' &&
        error.detailCode === 'STATUS_COMMAND_STDERR_UNEXPECTED'
    )
  );
  check(() =>
    assert.equal(
      statusPayloadFromCommandResult({
        stdout: 'cat: no_backup/other.json: No such file or directory\n',
        stderr: ''
      }),
      'cat: no_backup/other.json: No such file or directory\n'
    )
  );
  check(() =>
    assert.equal(
      statusPayloadFromCommandResult({
        stdout: `${STATUS_MISSING_LINE}\n\n`,
        stderr: ''
      }),
      `${STATUS_MISSING_LINE}\n\n`
    )
  );
  check(() =>
    assert.equal(
      nearestRankP95(Array.from({ length: 100 }, (_, index) => index + 1)),
      95
    )
  );
  check(() => assert.equal(nearestRankP95([]), null));
  check(() =>
    assert.throws(
      () => parseStatus(JSON.stringify({ ...statusFixture(), token: 'forbidden' })),
      /forbidden field/
    )
  );
  check(() =>
    assert.throws(
      () => parseStatus(JSON.stringify({ ...statusFixture(), ready: false })),
      /does not match/
    )
  );
  check(() =>
    assert.throws(
      () => parseStatus(`${JSON.stringify(statusFixture())}x`),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'STATUS_INVALID' &&
        error.detailCode === 'JSON_SYNTAX_INVALID'
    )
  );
  check(() =>
    assert.throws(
      () => parseStatus(JSON.stringify({ ...statusFixture(), sampleSequence: 0 })),
      /must start at one/
    )
  );
  const options = parseArgs([
    '--dry-run',
    '--cycles',
    '100',
    '--handheld-package',
    EXPECTED_TARGETS.handheld.packageId
  ]);
  check(() => assert.equal(options.cycles, 100));
  check(() => assert.equal(options.dryRun, true));
  check(() =>
    assert.equal(options.formalQuiescenceMs, FORMAL_MIN_QUIESCENCE_MS)
  );
  check(() =>
    assert.equal(
      parseArgs([
        '--dry-run',
        '--formal-quiescence-ms',
        '45000'
      ]).formalQuiescenceMs,
      45_000
    )
  );
  check(() =>
    assert.throws(
      () => parseArgs(['--dry-run', '--formal-quiescence-ms', '30000']),
      (error) =>
        error instanceof B2GateError && error.code === 'INVALID_ARGUMENT'
    )
  );
  check(() =>
    assert.throws(
      () => parseArgs(['--dry-run', '--cycle-gap-ms', '500']),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'FORMAL_QUIESCENCE_CONTRACT_INVALID'
    )
  );
  check(() =>
    assert.equal(
      redactText('device SERIAL failed', ['SERIAL']),
      'device [DEVICE_SERIAL] failed'
    )
  );
  const dryRun = buildDryRun(options);
  check(() => assert.equal(dryRun.adbExecuted, false));
  check(() => assert.equal(dryRun.resultContainsDeviceSerials, false));
  check(() =>
    assert.strictEqual(
      dryRun.certificationMatrixBinding,
      ADVANCED_CERTIFICATION_TARGETS_BINDING
    )
  );
  check(() =>
    assert.match(
      dryRun.certificationMatrixBinding.matrixSha256,
      /^[0-9a-f]{64}$/u
    )
  );
  check(() => assert.equal(dryRun.scope, 'DISCOVERY_ONLY_POST_ENROLLMENT'));
  check(() => assert.equal(dryRun.requiresPreEnrolledIdentity, true));
  check(() => assert.equal(dryRun.stagesEnrollmentQr, false));
  check(() => assert.equal(dryRun.formalQuiescenceEvidenceExpected, true));
  check(() =>
    assert.equal(
      dryRun.formalQuiescenceContract.requiredTotalQuiescenceIntervals,
      DEFAULT_CYCLES
    )
  );
  check(() =>
    assert.equal(
      dryRun.extendedEnrollmentAndCaptureHarness,
      'scripts/run-b2-android-adb-harness.mjs'
    )
  );
  check(() => assert.equal(dryRun.peerIdentityDerivedFromAnonymousPeerCount, false));
  const diagnosticOptions = parseArgs([
    '--dry-run',
    '--diagnostic-handheld-pair',
    '--cycles',
    '3',
    '--handheld-a-serial',
    'diagnostic-a',
    '--handheld-b-serial',
    'diagnostic-b'
  ]);
  const diagnosticDryRun = buildDryRun(diagnosticOptions);
  check(() => assert.equal(diagnosticOptions.diagnosticHandheldPair, true));
  check(() => assert.equal(diagnosticOptions.cycles, 3));
  check(() => assert.equal(diagnosticDryRun.evidenceClass, 'NON_GATE_EVIDENCE'));
  check(() => assert.equal(diagnosticDryRun.b2PromotionAllowed, false));
  check(() => assert.equal(diagnosticDryRun.certificationEligible, false));
  check(() => assert.equal(diagnosticDryRun.formalTargetMappingPreserved, true));
  check(() => assert.equal(diagnosticDryRun.adbExecuted, false));
  check(() => assert.equal(diagnosticDryRun.resultContainsDeviceSerials, false));
  check(() =>
    assert.strictEqual(
      diagnosticDryRun.certificationMatrixBinding,
      ADVANCED_CERTIFICATION_TARGETS_BINDING
    )
  );
  check(() => assert.equal(EXPECTED_TARGETS.handheld.nodeKind, 'handheld'));
  check(() => assert.equal(EXPECTED_TARGETS.station.nodeKind, 'station'));
  check(() =>
    assert.throws(
      () =>
        parseArgs([
          '--dry-run',
          '--diagnostic-handheld-pair',
          '--formal-quiescence-ms',
          '31000'
        ]),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'DIAGNOSTIC_ISOLATION_INVALID'
    )
  );
  check(() =>
    assert.throws(
      () =>
        parseArgs([
          '--dry-run',
          '--diagnostic-handheld-pair',
          '--station-serial',
          EXPECTED_TARGETS.station.serial
        ]),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'DIAGNOSTIC_ISOLATION_INVALID'
    )
  );
  check(() =>
    assert.throws(
      () =>
        parseArgs([
          '--dry-run',
          '--diagnostic-handheld-pair',
          '--handheld-a-serial',
          'same-diagnostic',
          '--handheld-b-serial',
          'same-diagnostic'
        ]),
      (error) => error instanceof B2GateError && error.code === 'INVALID_ARGUMENT'
    )
  );
  const evidenceFixtureDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'v6-b2-evidence-')
  );
  const evidenceFixture = path.join(evidenceFixtureDirectory, 'evidence.bin');
  fs.writeFileSync(evidenceFixture, 'fixture\n', { mode: 0o600 });
  check(() => assert.equal(inspectEvidenceFile(evidenceFixture, 'self-test evidence'), true));
  fs.chmodSync(evidenceFixture, 0o644);
  check(() =>
    assert.throws(
      () => inspectEvidenceFile(evidenceFixture, 'self-test evidence'),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'EXTERNAL_EVIDENCE_INVALID'
    )
  );
  fs.chmodSync(evidenceFixture, 0o600);
  const evidenceHardLink = path.join(evidenceFixtureDirectory, 'evidence-link.bin');
  fs.linkSync(evidenceFixture, evidenceHardLink);
  check(() =>
    assert.throws(
      () => inspectEvidenceFile(evidenceFixture, 'self-test evidence'),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'EXTERNAL_EVIDENCE_INVALID'
    )
  );
  fs.unlinkSync(evidenceHardLink);
  check(() =>
    assert.throws(
      () =>
        inspectEvidenceFile(
          path.resolve(process.argv[1], 'missing-evidence'),
          'self-test evidence'
        ),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'EXTERNAL_EVIDENCE_INVALID'
    )
  );
  fs.rmSync(evidenceFixtureDirectory, { recursive: true, force: true });
  check(() =>
    assert.throws(
      () =>
        parseArgs([
          '--dry-run',
          '--handheld-package',
          EXPECTED_TARGETS.station.packageId
        ]),
      (error) => error instanceof B2GateError && error.code === 'TARGET_ROLE_MISMATCH'
    )
  );
  check(() =>
    assert.throws(
      () =>
        parseArgs([
          '--handheld-serial',
          EXPECTED_TARGETS.handheld.serial,
          '--station-serial',
          EXPECTED_TARGETS.station.serial,
          '--cycles',
          '99',
          '--rf-evidence',
          '/tmp/rf',
          '--capture-evidence',
          '/tmp/capture'
        ]),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'CERTIFICATION_CYCLE_COUNT_INVALID'
    )
  );
  check(() =>
    assert.throws(
      () =>
        parseArgs([
          '--handheld-serial',
          EXPECTED_TARGETS.handheld.serial,
          '--station-serial',
          EXPECTED_TARGETS.station.serial,
          '--rf-evidence',
          '/tmp/same-evidence',
          '--capture-evidence',
          '/tmp/same-evidence'
        ]),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'EXTERNAL_EVIDENCE_INVALID'
    )
  );
  check(() => assert.equal(parseCurrentUser('10\n', 'handheld'), 10));
  check(() =>
    assert.deepEqual(
      buildCurrentUserRunAsArgs('com.example.lab', 10, 'cat', STATUS_PATH),
      [
        'exec-out',
        'run-as',
        'com.example.lab',
        '--user',
        '10',
        'cat',
        STATUS_PATH
      ]
    )
  );
  check(() =>
    assert.deepEqual(
      parseInstalledVersion(
        `  versionCode=${EXPECTED_TARGETS.handheld.versionCode} minSdk=24\n` +
          `  versionName=${EXPECTED_TARGETS.handheld.versionName}\n`,
        'handheld'
      ),
      {
        versionCode: EXPECTED_TARGETS.handheld.versionCode,
        versionName: EXPECTED_TARGETS.handheld.versionName
      }
    )
  );
  check(() =>
    assert.equal(
      parseInstalledApkPath('package:/data/app/example/base.apk\n', 'handheld'),
      '/data/app/example/base.apk'
    )
  );
  check(() =>
    assert.equal(
      parseInstalledApkSha256(
        `${EXPECTED_TARGETS.handheld.sha256}  /data/app/example/base.apk\n`,
        'handheld'
      ),
      EXPECTED_TARGETS.handheld.sha256
    )
  );
  for (const role of ['handheld', 'station']) {
    check(() =>
      assert.deepEqual(
        Object.fromEntries(
          CERTIFICATION_TARGET_FIELDS.map((field) => [
            field,
            EXPECTED_TARGETS[role][field]
          ])
        ),
        ADVANCED_CERTIFICATION_TARGETS.roles[role]
      )
    );
  }
  const multiUserPermissionDump = [
    '  User 0:',
    '    runtime permissions:',
    '      android.permission.BLUETOOTH_SCAN: granted=true',
    '  User 10:',
    '    runtime permissions:',
    '      android.permission.BLUETOOTH_SCAN: granted=false'
  ].join('\n');
  check(() =>
    assert.equal(
      permissionGrantedForUser(
        multiUserPermissionDump,
        10,
        'android.permission.BLUETOOTH_SCAN'
      ),
      false
    )
  );
  check(() =>
    assert.equal(
      permissionGrantedForUser(
        multiUserPermissionDump,
        0,
        'android.permission.BLUETOOTH_SCAN'
      ),
      true
    )
  );

  const firstStatus = statusFixture();
  firstStatus.metrics.scanWindowsStarted = 1;
  firstStatus.metrics.advertisementsStarted = 1;
  firstStatus.metrics.acceptedObservations = 1;
  firstStatus.metrics.firstObservationOffsetP95Ms = 500;
  firstStatus.metrics.peerDirectory.added = 1;
  firstStatus.metrics.peerDirectory.newStreamAttempts = 1;
  firstStatus.metrics.peerDirectory.newStreamsAccepted = 1;
  firstStatus.metrics.peerDirectory.newStreamAttemptWindowsStarted = 1;
  firstStatus.metrics.peerDirectory.capacityHighWatermark = 1;
  const tracker = {
    reporterStartedAtEpochMs: null,
    lastSequence: null,
    lastSampledAtEpochMs: null,
    lastFingerprint: null,
    distinctSamples: 0
  };
  check(() => validateFreshSequence(firstStatus, tracker, 1_000, 500, 'handheld'));
  const secondStatus = structuredClone(firstStatus);
  secondStatus.sampleSequence = 2;
  secondStatus.sampledAtEpochMs = 1_200;
  check(() => validateFreshSequence(secondStatus, tracker, 1_000, 500, 'handheld'));
  check(() => assert.equal(tracker.distinctSamples, 2));
  check(() => assertOperationalMetrics(secondStatus, 'handheld'));
  check(() =>
    assert.equal(hasOperationalAnonymousPeerEvidence(secondStatus, tracker), true)
  );
  check(() =>
    assert.equal(
      terminalReadinessPersistedBeyondGrace(6_000, 20),
      false
    )
  );
  check(() =>
    assert.equal(
      terminalReadinessPersistedBeyondGrace(8_001, 2),
      false
    )
  );
  check(() =>
    assert.equal(
      terminalReadinessPersistedBeyondGrace(8_001, 3),
      true
    )
  );
  const p95AtLimit = structuredClone(secondStatus);
  p95AtLimit.metrics.firstObservationOffsetP95Ms = B2_P95_LIMIT_MS;
  check(() =>
    assert.equal(
      hasOperationalAnonymousPeerEvidence(p95AtLimit, tracker),
      true
    )
  );
  const p95AboveLimit = structuredClone(secondStatus);
  p95AboveLimit.metrics.firstObservationOffsetP95Ms = B2_P95_LIMIT_MS + 1;
  check(() =>
    assert.equal(
      hasOperationalAnonymousPeerEvidence(p95AboveLimit, tracker),
      false
    )
  );
  check(() =>
    assert.equal(
      hasOperationalAnonymousPeerEvidence(secondStatus, {
        ...tracker,
        distinctSamples: 1
      }),
      false
    )
  );
  const inactiveAdvertising = structuredClone(secondStatus);
  inactiveAdvertising.metrics.advertisementsStarted = 0;
  check(() =>
    assert.equal(
      hasOperationalAnonymousPeerEvidence(inactiveAdvertising, tracker),
      false
    )
  );

  const reusedSequence = structuredClone(secondStatus);
  reusedSequence.activePeerCount = 2;
  check(() =>
    assert.throws(
      () => validateFreshSequence(reusedSequence, tracker, 1_000, 500, 'handheld'),
      (error) => error instanceof B2GateError && error.code === 'STATUS_SEQUENCE_REUSED'
    )
  );
  const restartedReporter = structuredClone(secondStatus);
  restartedReporter.sampleSequence = 3;
  restartedReporter.sampledAtEpochMs = 1_300;
  restartedReporter.reporterStartedAtEpochMs = 1_250;
  check(() =>
    assert.throws(
      () =>
        validateFreshSequence(
          restartedReporter,
          tracker,
          1_000,
          500,
          'handheld'
        ),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'STATUS_REPORTER_RESTARTED'
    )
  );
  const staleStatus = structuredClone(firstStatus);
  staleStatus.reporterStartedAtEpochMs = 999;
  check(() =>
    assert.throws(
      () =>
        validateFreshSequence(
          staleStatus,
          {
            reporterStartedAtEpochMs: null,
            lastSequence: null,
            lastSampledAtEpochMs: null,
            lastFingerprint: null,
            distinctSamples: 0
          },
          1_000,
          500,
          'handheld'
        ),
      (error) => error instanceof B2GateError && error.code === 'STATUS_NOT_FRESH'
    )
  );
  const failedMetrics = structuredClone(secondStatus);
  failedMetrics.metrics.scanIngressDropped = 1;
  check(() =>
    assert.throws(
      () => assertOperationalMetrics(failedMetrics, 'handheld'),
      (error) => error instanceof B2GateError && error.code === 'RADIO_METRICS_FAILED'
    )
  );
  const failedDirectoryMetrics = structuredClone(secondStatus);
  failedDirectoryMetrics.metrics.peerDirectory.directoryFull = 1;
  check(() =>
    assert.throws(
      () => assertOperationalMetrics(failedDirectoryMetrics, 'handheld'),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'PEER_DIRECTORY_METRICS_FAILED'
    )
  );
  const inconsistentDirectoryMetrics = structuredClone(secondStatus);
  inconsistentDirectoryMetrics.metrics.peerDirectory.newStreamsAccepted = 0;
  check(() =>
    assert.throws(
      () => assertOperationalMetrics(inconsistentDirectoryMetrics, 'handheld'),
      (error) =>
        error instanceof B2GateError &&
        error.code === 'PEER_DIRECTORY_METRICS_INCONSISTENT'
    )
  );

  const passingCycles = Array.from({ length: DEFAULT_CYCLES }, (_, index) => ({
    cycle: index + 1,
    outcome: 'PASS',
    anonymousPeerPresenceMs: 1_000 + index
  }));
  const formalQuiescenceIntervals = Array.from(
    { length: DEFAULT_CYCLES },
    (_, index) => ({
      phase: index === 0 ? 'INITIAL' : 'INTER_CYCLE',
      afterCycle: index === 0 ? null : index,
      beforeCycle: index + 1,
      requestedMs: FORMAL_MIN_QUIESCENCE_MS,
      observedMs: FORMAL_MIN_QUIESCENCE_MS,
      clock: 'HOST_MONOTONIC',
      startsAfterBothForceStops: true
    })
  );
  const summaryOptions = {
    cycles: DEFAULT_CYCLES,
    formalQuiescenceMs: FORMAL_MIN_QUIESCENCE_MS,
    rfEvidenceProvided: true,
    captureEvidenceProvided: true
  };
  const preflightFixture = ['handheld', 'station'].map((role) => ({
    role,
    currentAndroidUserVerified: true,
    expectedSerialVerified: true,
    expectedModelVerified: true,
    expectedPackageVerified: true,
    expectedAppVersionVerified: true,
    expectedApkSha256Verified: true,
    currentUserBluetoothPermissionsGranted: true,
    fullNodeCapabilityGate: 'VERIFIED_DURING_EACH_CYCLE'
  }));
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      ).localMeasurementVerdict,
      'PASS'
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      ).gate,
      'PENDING'
    )
  );
  check(() =>
    assert.strictEqual(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      )
        .certificationMatrixBinding,
      ADVANCED_CERTIFICATION_TARGETS_BINDING
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      ).formalQuiescenceEvidenceComplete,
      true
    )
  );
  const missingFormalQuiescence = formalQuiescenceIntervals.slice(0, -1);
  check(() => {
    const summary = buildSummary(
      summaryOptions,
      preflightFixture,
      passingCycles,
      false,
      missingFormalQuiescence
    );
    assert.equal(summary.formalQuiescenceEvidenceComplete, false);
    assert.equal(summary.localMeasurementVerdict, 'PENDING');
    assert.equal(summary.gateReason, 'FORMAL_QUIESCENCE_EVIDENCE_INCOMPLETE');
  });
  const shortFormalQuiescence = structuredClone(formalQuiescenceIntervals);
  shortFormalQuiescence[49].observedMs = FORMAL_MIN_QUIESCENCE_MS - 1;
  check(() => {
    const summary = buildSummary(
      summaryOptions,
      preflightFixture,
      passingCycles,
      false,
      shortFormalQuiescence
    );
    assert.equal(summary.formalQuiescenceEvidenceComplete, false);
    assert.equal(summary.localMeasurementVerdict, 'PENDING');
  });
  const mismatchedFormalQuiescence = structuredClone(formalQuiescenceIntervals);
  mismatchedFormalQuiescence[75].requestedMs = FORMAL_MIN_QUIESCENCE_MS + 1;
  mismatchedFormalQuiescence[75].observedMs = FORMAL_MIN_QUIESCENCE_MS + 1;
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        mismatchedFormalQuiescence
      ).formalQuiescenceEvidenceComplete,
      false
    )
  );
  const diagnosticPreflight = ['handheld_a', 'handheld_b'].map((role) => ({
    role,
    certificationRole: 'handheld',
    formalCertificationEligible: false,
    currentAndroidUserVerified: true,
    expectedSerialVerified: false,
    expectedModelVerified: false,
    expectedPackageVerified: true,
    expectedAppVersionVerified: true,
    expectedApkSha256Verified: true,
    currentUserBluetoothPermissionsGranted: true,
    fullNodeCapabilityGate: 'VERIFIED_DURING_EACH_CYCLE'
  }));
  const diagnosticCycles = Array.from({ length: DEFAULT_CYCLES }, (_, index) => ({
    cycle: index + 1,
    outcome: 'PASS',
    evidenceOrigin: 'LIVE_ADB_PRIVATE_STATUS',
    intentionalBoundaryForceStopVerified: true,
    anonymousPeerPresenceMs: 1_000 + index,
    devices: ['handheld_a', 'handheld_b'].map((role) => ({
      role,
      reporterLifecyclePolicy: 'EXPECTED_RESTART_AT_CYCLE_BOUNDARY_ONLY',
      reporterInstanceFreshForCycle: true,
      withinCycleReporterRestartDetected: false
    }))
  }));
  const diagnosticSummaryOptions = {
    ...diagnosticOptions,
    cycles: DEFAULT_CYCLES,
    physicalAdbAccessed: true
  };
  const diagnosticSummary = buildDiagnosticSummary(
    diagnosticSummaryOptions,
    diagnosticPreflight,
    diagnosticCycles,
    false
  );
  check(() => assert.equal(diagnosticSummary.localMeasurementVerdict, 'PASS'));
  check(() => assert.equal(diagnosticSummary.evidenceClass, 'NON_GATE_EVIDENCE'));
  check(() => assert.equal(diagnosticSummary.gate, 'PENDING'));
  check(() => assert.equal(diagnosticSummary.b2PromotionAllowed, false));
  check(() => assert.equal(diagnosticSummary.certificationEligible, false));
  check(() => assert.equal(diagnosticSummary.formalTargetMappingPreserved, true));
  check(() => assert.equal(diagnosticSummary.physicalCertificationPassEmittedByHarness, false));
  check(() => assert.equal(diagnosticSummary.liveCycleEvidenceComplete, true));
  check(() =>
    assert.strictEqual(
      diagnosticSummary.certificationMatrixBinding,
      ADVANCED_CERTIFICATION_TARGETS_BINDING
    )
  );
  const cooldownPilotOptions = parseArgs([
    '--dry-run',
    '--diagnostic-cooldown-pilot',
    '--handheld-a-serial',
    'pilot-a',
    '--handheld-b-serial',
    'pilot-b'
  ]);
  const cooldownPilotCycles = diagnosticCycles.slice(
    0,
    COOLDOWN_PILOT_CYCLES
  );
  const cooldownPilotQuiescence = Array.from(
    { length: COOLDOWN_PILOT_CYCLES },
    (_, index) => ({
      phase: index === 0 ? 'INITIAL' : 'INTER_CYCLE',
      afterCycle: index === 0 ? null : index,
      beforeCycle: index + 1,
      requestedMs: COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
      observedMs: COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
      clock: 'HOST_MONOTONIC',
      startsAfterBothForceStops: true
    })
  );
  const cooldownPilotSummary = buildDiagnosticSummary(
    { ...cooldownPilotOptions, physicalAdbAccessed: true },
    diagnosticPreflight,
    cooldownPilotCycles,
    false,
    cooldownPilotQuiescence
  );
  check(() => assert.equal(cooldownPilotOptions.cycles, COOLDOWN_PILOT_CYCLES));
  check(() => assert.equal(cooldownPilotSummary.pilotVerdict, 'PASS'));
  check(() => assert.equal(cooldownPilotSummary.gate, 'PENDING'));
  check(() => assert.equal(cooldownPilotSummary.b2PromotionAllowed, false));
  check(() => assert.equal(cooldownPilotSummary.quiescenceEvidenceComplete, true));
  const shortQuiescence = structuredClone(cooldownPilotQuiescence);
  shortQuiescence[0].observedMs = COOLDOWN_PILOT_MIN_QUIESCENCE_MS - 1;
  check(() =>
    assert.equal(
      buildDiagnosticSummary(
        { ...cooldownPilotOptions, physicalAdbAccessed: true },
        diagnosticPreflight,
        cooldownPilotCycles,
        false,
        shortQuiescence
      ).pilotVerdict,
      'PENDING'
    )
  );
  let monotonicNowMs = 10_000;
  const observedQuiescenceMs = await measureMinimumQuiescence(
    COOLDOWN_PILOT_MIN_QUIESCENCE_MS,
    {
      now: () => monotonicNowMs,
      sleepFn: async (delayMs) => {
        monotonicNowMs += delayMs;
      }
    }
  );
  check(() =>
    assert.equal(
      observedQuiescenceMs,
      COOLDOWN_PILOT_MIN_QUIESCENCE_MS
    )
  );
  const redactedFailureDetail = compactFailureDetail(
    new B2GateError('STATUS_INVALID', 'private parser detail', {
      detailCode: 'JSON_SYNTAX_INVALID_PERSISTENT',
      failedRole: 'handheld_b'
    }),
    [
      { role: 'handheld_a' },
      { role: 'handheld_b' }
    ]
  );
  check(() =>
    assert.deepEqual(redactedFailureDetail, {
      reasonDetailCode: 'JSON_SYNTAX_INVALID_PERSISTENT',
      reasonRole: 'handheld_b'
    })
  );
  check(() =>
    assert.deepEqual(
      compactFailureDetail(
        new B2GateError(
          'ANONYMOUS_PEER_PRESENCE_TIMEOUT',
          'private timeout detail',
          { failedRole: 'both' }
        ),
        [{ role: 'handheld_a' }, { role: 'handheld_b' }]
      ),
      { reasonRole: 'both' }
    )
  );
  check(() =>
    assert.deepEqual(
      compactFailureDetail(
        new B2GateError('STATUS_INVALID', 'private parser detail', {
          failedRole: 'both'
        }),
        [{ role: 'handheld_a' }, { role: 'handheld_b' }]
      ),
      {}
    )
  );
  check(() =>
    assert.deepEqual(
      compactFailureDetail(
        new B2GateError('STATUS_INVALID', 'private parser detail', {
          detailCode: 'not public',
          failedRole: 'unknown-role'
        }),
        [{ role: 'handheld_a' }]
      ),
      {}
    )
  );
  const timeoutTelemetry = compactDeviceCycle(
    { role: 'handheld_a' },
    {
      launchCommandCompletedMs: 120,
      statusFirstReadableMs: 900,
      readyMs: 3_900,
      observedMs: null,
      firstScanWindowMs: 3_900,
      firstAdvertisementStartedMs: 4_100
    },
    secondStatus,
    {
      distinctSamples: 7,
      lastSequence: 8,
    lastSampleObservedAtCycleMs: 14_800,
    lastSampleObservationAgeMs: 200
    }
  );
  check(() => assert.equal(timeoutTelemetry.scanWindowsStarted, 1));
  check(() => assert.equal(timeoutTelemetry.scanWindowsCompleted, 0));
  check(() => assert.equal(timeoutTelemetry.advertisementsStarted, 1));
  check(() => assert.equal(timeoutTelemetry.advertisementUpdates, 0));
  check(() => assert.equal(timeoutTelemetry.lastSampleSequence, 8));
  check(() => assert.equal(timeoutTelemetry.lastSampleObservedAtCycleMs, 14_800));
  check(() => assert.equal(timeoutTelemetry.lastSampleObservationAgeMs, 200));
  check(() => assert.equal(timeoutTelemetry.firstAnonymousPeerPresenceMs, null));
  check(() =>
    assert.equal(Object.hasOwn(timeoutTelemetry, 'reporterStartedAtEpochMs'), false)
  );
  const observedTimeoutTelemetry = {
    ...timeoutTelemetry,
    firstAnonymousPeerPresenceMs: 7_500
  };
  check(() =>
    assert.equal(
      inferAnonymousPeerPresenceTimeoutRole([
        timeoutTelemetry,
        { ...observedTimeoutTelemetry, role: 'handheld_b' }
      ]),
      'handheld_a'
    )
  );
  check(() =>
    assert.equal(
      inferAnonymousPeerPresenceTimeoutRole([
        observedTimeoutTelemetry,
        { ...timeoutTelemetry, role: 'handheld_b' }
      ]),
      'handheld_b'
    )
  );
  check(() =>
    assert.equal(
      inferAnonymousPeerPresenceTimeoutRole([
        timeoutTelemetry,
        { ...timeoutTelemetry, role: 'handheld_b' }
      ]),
      'both'
    )
  );
  const restartedLifecycle = applyLifecycleFailureTelemetry(
    [
      timeoutTelemetry,
      { ...timeoutTelemetry, role: 'handheld_b' }
    ],
    new B2GateError('STATUS_REPORTER_RESTARTED', 'private', {
      failedRole: 'handheld_a'
    })
  );
  check(() =>
    assert.equal(restartedLifecycle[0].reporterInstanceFreshForCycle, false)
  );
  check(() =>
    assert.equal(restartedLifecycle[0].withinCycleReporterRestartDetected, true)
  );
  check(() =>
    assert.equal(restartedLifecycle[1].withinCycleReporterRestartDetected, false)
  );
  const unknownFailureLifecycle = compactFailureStatus(
    [{ role: 'handheld_a' }],
    [null]
  );
  check(() =>
    assert.equal(
      unknownFailureLifecycle[0].reporterInstanceFreshForCycle,
      false
    )
  );
  const timeoutCycleTiming = compactCycleTiming(
    [
      timeoutTelemetry,
      { ...timeoutTelemetry, role: 'handheld_b', readyMs: 4_100 }
    ],
    15_100,
    true,
    15_000,
    14_900
  );
  check(() => assert.equal(timeoutCycleTiming.bothReadyMs, 4_100));
  check(() => assert.equal(timeoutCycleTiming.peerPresenceAfterBothReadyMs, null));
  check(() => assert.equal(timeoutCycleTiming.timeoutCensored, true));
  check(() =>
    assert.equal(timeoutCycleTiming.harnessObservationCensorAtMs, 14_900)
  );
  const censoredCycles = [
    ...Array.from({ length: 73 }, (_, index) => ({
      outcome: 'PASS',
      anonymousPeerPresenceMs: 4_000 + index,
      peerPresenceAfterBothReadyMs: 500 + index
    })),
    ...Array.from({ length: 27 }, () => ({
      outcome: 'PENDING',
      reasonCode: 'ANONYMOUS_PEER_PRESENCE_TIMEOUT',
      harnessObservationCensorAtMs: 14_900
    }))
  ];
  const censoredAccounting = buildLatencyAccounting(
    { timeoutMs: 15_000 },
    censoredCycles
  );
  check(() => assert.equal(censoredAccounting.p95Population, 'PASS_CYCLES_ONLY'));
  check(() => assert.equal(censoredAccounting.censoredCycleCount, 27));
  check(() =>
    assert.equal(
      censoredAccounting.allCycleHarnessObservationP95LowerBoundMs,
      14_900
    )
  );
  check(() => assert.equal(censoredAccounting.timeoutsCountAsFailures, true));
  check(() =>
    assert.deepEqual(
      buildTimingConfiguration({
        diagnosticHandheldPair: true,
        timeoutMs: 25_000,
        pollMs: 250,
        cycleGapMs: 500
      }),
      {
        timeoutMs: 25_000,
        pollMs: 250,
        cycleGapMs: 500,
        latencyClockOrigin: 'CYCLE_LAUNCH',
        requiredMaximumP95Ms: B2_P95_LIMIT_MS
      }
    )
  );
  check(() =>
    assert.equal(
      buildDiagnosticSummary(
        { ...diagnosticSummaryOptions, physicalAdbAccessed: false },
        diagnosticPreflight,
        diagnosticCycles,
        false
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  const missingLifecycleEvidence = structuredClone(diagnosticCycles);
  missingLifecycleEvidence[0].devices[0].reporterInstanceFreshForCycle = false;
  check(() =>
    assert.equal(
      buildDiagnosticSummary(
        diagnosticSummaryOptions,
        diagnosticPreflight,
        missingLifecycleEvidence,
        false
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  check(() =>
    assert.equal(
      buildDiagnosticSummary(
        diagnosticSummaryOptions,
        diagnosticPreflight,
        diagnosticCycles.slice(0, -1),
        true
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        [],
        passingCycles,
        false,
        formalQuiescenceIntervals
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  const unverifiedApkPreflight = structuredClone(preflightFixture);
  unverifiedApkPreflight[0].expectedApkSha256Verified = false;
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        unverifiedApkPreflight,
        passingCycles,
        false,
        formalQuiescenceIntervals
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  const duplicateCycle = passingCycles.map((cycle, index) => ({
    ...cycle,
    cycle: index === DEFAULT_CYCLES - 1 ? index : cycle.cycle
  }));
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        duplicateCycle,
        false,
        formalQuiescenceIntervals
      ).gate,
      'PENDING'
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        duplicateCycle,
        false,
        formalQuiescenceIntervals
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        { ...summaryOptions, cycles: DEFAULT_CYCLES - 1 },
        preflightFixture,
        passingCycles.slice(0, -1),
        false,
        formalQuiescenceIntervals.slice(0, -1)
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  const slowCycles = passingCycles.map((cycle, index) => ({
    ...cycle,
    anonymousPeerPresenceMs: index < 94 ? 1_000 : 8_001
  }));
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        slowCycles,
        false,
        formalQuiescenceIntervals
      ).localMeasurementVerdict,
      'PENDING'
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        { ...summaryOptions, captureEvidenceProvided: false },
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      ).localMeasurementVerdict,
      'PASS'
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      )
        .externalEvidence.authenticityVerifiedByHarness,
      false
    )
  );
  check(() =>
    assert.equal(
      buildSummary(
        summaryOptions,
        preflightFixture,
        passingCycles,
        false,
        formalQuiescenceIntervals
      )
        .externalEvidence.controllerCaptureProvided,
      false
    )
  );
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    source: 'V6_B2_ANDROID_GATE_HARNESS_SELF_TEST',
    certificationMatrixBinding: ADVANCED_CERTIFICATION_TARGETS_BINDING,
    result: 'PASS',
    tests,
    coverage: {
      transientSyntaxReadRecovered: true,
      persistentSyntaxReadRejected: true,
      nonSyntaxValidationFailedImmediately: true,
      failureDetailRedacted: true,
      exitZeroMissingStatusRecognized: true,
      missingStatusAllowlistIsExact: true,
      terminalReadinessGraceMatchesSla: true,
      p95LimitUnchanged: true,
      timeoutTelemetryPreserved: true,
      censoredLatencyExplicit: true,
      failureLifecycleTruthful: true,
      timeoutRoleAttribution: true,
      matrixDrivenCertificationTargets: true,
      publicCertificationMatrixBinding: true,
      formalQuiescenceContractEnforced: true,
      formalQuiescenceMissingFailsClosed: true,
      formalQuiescenceShortFailsClosed: true,
      cooldownPilotContractEnforced: true,
      minimumQuiescenceMeasured: true
    }
  };
}

function writePrivateResult(outputPath, payload) {
  const destination = path.resolve(outputPath);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryFlag = fs.constants.O_DIRECTORY ?? 0;
  let directoryDescriptor;
  let temporaryDescriptor;
  let temporaryPath;
  try {
    directoryDescriptor = fs.openSync(
      parent,
      fs.constants.O_RDONLY | directoryFlag | noFollow
    );
    if (!fs.fstatSync(directoryDescriptor).isDirectory()) {
      throw new B2GateError(
        'OUTPUT_PATH_INVALID',
        'evidence output parent must be a regular directory'
      );
    }
    const directoryPath = process.platform === 'linux'
      ? `/proc/self/fd/${directoryDescriptor}`
      : parent;
    temporaryPath = path.join(
      directoryPath,
      `.b2-evidence-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    temporaryDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600
    );
    fs.fchmodSync(temporaryDescriptor, 0o600);
    fs.writeFileSync(temporaryDescriptor, payload, 'utf8');
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    try {
      fs.linkSync(
        temporaryPath,
        path.join(directoryPath, path.basename(destination))
      );
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new B2GateError(
          'OUTPUT_EXISTS',
          'evidence output is immutable and cannot be overwritten'
        );
      }
      throw error;
    }
    fs.fsyncSync(directoryDescriptor);
    fs.unlinkSync(temporaryPath);
    temporaryPath = undefined;
    fs.fsyncSync(directoryDescriptor);
  } finally {
    if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
    if (temporaryPath !== undefined) fs.rmSync(temporaryPath, { force: true });
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
}

function writeResult(outputPath, result, secrets = []) {
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (secrets.some((secret) => secret && payload.includes(secret))) {
    throw new B2GateError(
      'OUTPUT_IDENTIFIER_DETECTED',
      'redacted output contains a device identifier'
    );
  }
  if (outputPath) {
    writePrivateResult(outputPath, payload);
  }
  process.stdout.write(payload);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.selfTest) {
    if (process.argv.length !== 3) {
      throw new B2GateError('INVALID_ARGUMENT', '--self-test cannot be combined');
    }
    writeResult(null, await runSelfTest());
    return;
  }
  if (options.dryRun) {
    writeResult(
      options.output,
      buildDryRun(options),
      options.diagnosticHandheldPair
        ? [options.handheldASerial, options.handheldBSerial]
        : [options.handheldSerial, options.stationSerial]
    );
    return;
  }
  if (options.diagnosticHandheldPair) {
    options.rfEvidenceProvided = false;
    options.captureEvidenceProvided = false;
  } else {
    options.rfEvidenceProvided = inspectEvidenceFile(
      options.rfEvidence,
      '--rf-evidence'
    );
    options.captureEvidenceProvided = inspectEvidenceFile(
      options.captureEvidence,
      '--capture-evidence'
    );
  }

  const devices = options.diagnosticHandheldPair
    ? [
        {
          role: 'handheld_a',
          targetRole: 'handheld',
          serial: options.handheldASerial,
          packageId: EXPECTED_TARGETS.handheld.packageId
        },
        {
          role: 'handheld_b',
          targetRole: 'handheld',
          serial: options.handheldBSerial,
          packageId: EXPECTED_TARGETS.handheld.packageId
        }
      ]
    : [
        {
          role: 'handheld',
          serial: options.handheldSerial,
          packageId: options.handheldPackage
        },
        {
          role: 'station',
          serial: options.stationSerial,
          packageId: options.stationPackage
        }
      ];
  await ensureAttached(options, devices);
  const preflight = await Promise.all(
    devices.map((device) => preflightDevice(options, device))
  );
  options.physicalAdbAccessed = true;
  const cycles = [];
  const quiescenceIntervals = [];
  const previousReporterStarts = new Map();
  const measuredQuiescenceRequired =
    options.diagnosticCooldownPilot || !options.diagnosticHandheldPair;
  const configuredQuiescenceMs = options.diagnosticCooldownPilot
    ? options.quiescenceMs
    : options.formalQuiescenceMs;
  const quiescenceLabel = options.diagnosticCooldownPilot
    ? 'cooldown pilot'
    : 'formal quiescence';
  let stoppedEarly = false;
  try {
    if (measuredQuiescenceRequired) {
      await Promise.all(devices.map((device) => forceStop(options, device)));
      const observedMs = await measureMinimumQuiescence(configuredQuiescenceMs);
      quiescenceIntervals.push({
        phase: 'INITIAL',
        afterCycle: null,
        beforeCycle: 1,
        requestedMs: configuredQuiescenceMs,
        observedMs,
        clock: 'HOST_MONOTONIC',
        startsAfterBothForceStops: true
      });
      process.stderr.write(
        `B2 ${quiescenceLabel} before cycle 1/${options.cycles}: ${observedMs} ms\n`
      );
    }
    for (let cycleNumber = 1; cycleNumber <= options.cycles; cycleNumber += 1) {
      let cycle = null;
      let cycleError = null;
      try {
        cycle = await runCycle(
          options,
          devices,
          cycleNumber,
          previousReporterStarts
        );
      } catch (error) {
        if (!(error instanceof B2GateError)) throw error;
        cycleError = error;
      }
      try {
        await Promise.all(devices.map((device) => forceStop(options, device)));
      } catch (error) {
        cycleError = new B2GateError(
          'CYCLE_BOUNDARY_FORCE_STOP_FAILED',
          'the intentional cycle-boundary reporter shutdown failed',
          {
            fatal: true,
            lastStatuses: cycleError?.lastStatuses ?? [],
            cycleDevices: cycleError?.cycleDevices ?? cycle?.devices ?? [],
            cycleElapsedMs:
              cycleError?.cycleElapsedMs ?? cycle?.elapsedMs ?? null,
            harnessObservationCensorAtMs:
              cycleError?.harnessObservationCensorAtMs ?? null
          }
        );
      }
      if (cycle !== null && cycleError === null) {
        cycle.intentionalBoundaryForceStopVerified = true;
        cycles.push(cycle);
        process.stderr.write(
          `B2 cycle ${cycleNumber}/${options.cycles}: LOCAL PASS ${cycle.anonymousPeerPresenceMs} ms\n`
        );
      } else {
        const deviceTelemetry =
          cycleError.cycleDevices.length === devices.length
            ? cycleError.cycleDevices
            : compactFailureStatus(devices, cycleError.lastStatuses);
        const timeoutCensored =
          cycleError.code === 'ANONYMOUS_PEER_PRESENCE_TIMEOUT';
        cycles.push({
          cycle: cycleNumber,
          outcome: 'PENDING',
          evidenceOrigin: 'LIVE_ADB_PRIVATE_STATUS',
          reasonCode: cycleError.code,
          ...compactFailureDetail(cycleError, devices),
          ...compactCycleTiming(
            deviceTelemetry,
            cycleError.cycleElapsedMs,
            timeoutCensored,
            options.timeoutMs,
            cycleError.harnessObservationCensorAtMs
          ),
          intentionalBoundaryForceStopVerified:
            cycleError.code !== 'CYCLE_BOUNDARY_FORCE_STOP_FAILED',
          devices: deviceTelemetry
        });
        process.stderr.write(
          `B2 cycle ${cycleNumber}/${options.cycles}: PENDING ${cycleError.code}` +
            `${cycleError.detailCode ? `/${cycleError.detailCode}` : ''}\n`
        );
        if (cycleError.fatal) {
          stoppedEarly = true;
          break;
        }
      }
      if (cycleNumber < options.cycles) {
        if (measuredQuiescenceRequired) {
          const observedMs = await measureMinimumQuiescence(
            configuredQuiescenceMs
          );
          quiescenceIntervals.push({
            phase: 'INTER_CYCLE',
            afterCycle: cycleNumber,
            beforeCycle: cycleNumber + 1,
            requestedMs: configuredQuiescenceMs,
            observedMs,
            clock: 'HOST_MONOTONIC',
            startsAfterBothForceStops: true
          });
          process.stderr.write(
            `B2 ${quiescenceLabel} before cycle ${cycleNumber + 1}/${options.cycles}: ${observedMs} ms\n`
          );
        } else if (options.cycleGapMs > 0) {
          await sleep(options.cycleGapMs);
        }
      }
    }
  } finally {
    await Promise.all(
      devices.map((device) => forceStop(options, device).catch(() => undefined))
    );
  }
  const result = options.diagnosticHandheldPair
    ? buildDiagnosticSummary(
        options,
        preflight,
        cycles,
        stoppedEarly,
        quiescenceIntervals
      )
    : buildSummary(
        options,
        preflight,
        cycles,
        stoppedEarly,
        quiescenceIntervals
      );
  writeResult(
    options.output,
    result,
    options.diagnosticHandheldPair
      ? [options.handheldASerial, options.handheldBSerial]
      : [options.handheldSerial, options.stationSerial]
  );
  if (
    options.diagnosticHandheldPair
      ? result.localMeasurementVerdict !== 'PASS'
      : result.gate !== 'PASS'
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const code = error instanceof B2GateError ? error.code : 'UNEXPECTED_ERROR';
  const message = redactText(
    error instanceof Error ? error.message : String(error),
    [...RUNTIME_REDACTION_SECRETS]
  );
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
