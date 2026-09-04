import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADVANCED_CERTIFICATION_TARGETS_BINDING } from './advanced-certification-targets.mjs';

const SCRIPT = fileURLToPath(
  new URL('./run-b2-android-gate.mjs', import.meta.url)
);

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('self-test covers bounded transient status recovery and persistent rejection', () => {
  const child = run('--self-test');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.schemaVersion, 7);
  assert.equal(report.result, 'PASS');
  assert.deepEqual(report.coverage, {
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
  });
  assert.deepEqual(
    report.certificationMatrixBinding,
    ADVANCED_CERTIFICATION_TARGETS_BINDING
  );
});

test('certification versions are not duplicated as B2 gate literals', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /1\.0\.36/u);
  for (const target of Object.values(
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix.roles
  )) {
    for (const field of [
      'artifactRelativePath',
      'packageId',
      'sha256',
      'versionName'
    ]) {
      assert.equal(
        source.includes(target[field]),
        false,
        `${field} is duplicated`
      );
    }
  }
  assert.doesNotMatch(
    source,
    /EXPECTED_TARGETS\.(?:handheld|station)\.(?:versionCode|versionName)\s*,\s*(?:\d+|'[^']+'|"[^"]+")/u
  );
  assert.match(
    source,
    /ADVANCED_CERTIFICATION_TARGETS\.roles\[role\]/u
  );
});

test('handheld-pair dry run is explicitly non-gate and identifier-free', () => {
  const firstSerial = 'offline-diagnostic-a';
  const secondSerial = 'offline-diagnostic-b';
  const child = run(
    '--dry-run',
    '--diagnostic-handheld-pair',
    '--cycles',
    '3',
    '--handheld-a-serial',
    firstSerial,
    '--handheld-b-serial',
    secondSerial
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.schemaVersion, 7);
  assert.equal(report.evidenceClass, 'NON_GATE_EVIDENCE');
  assert.equal(report.b2PromotionAllowed, false);
  assert.equal(report.certificationEligible, false);
  assert.equal(report.formalTargetMappingPreserved, true);
  assert.equal(report.physicalCertificationPassEmittedByHarness, false);
  assert.equal(report.arbitraryEvidenceFilesAccepted, false);
  assert.equal(report.physicalAdbAccessed, false);
  assert.deepEqual(report.timingConfiguration, {
    timeoutMs: 15_000,
    pollMs: 250,
    cycleGapMs: 500,
    latencyClockOrigin: 'CYCLE_LAUNCH',
    requiredMaximumP95Ms: 8_000
  });
  assert.equal(
    report.evidenceCollection.reporterRestartPolicy,
    'EXPECTED_AT_CYCLE_BOUNDARY_ONLY'
  );
  assert.deepEqual(report.formalCertificationRolesUnaffected, [
    'handheld',
    'station'
  ]);
  assert.deepEqual(
    report.devices.map((device) => [device.role, device.certificationRole]),
    [
      ['handheld_a', 'handheld'],
      ['handheld_b', 'handheld']
    ]
  );
  assert.equal(child.stdout.includes(firstSerial), false);
  assert.equal(child.stdout.includes(secondSerial), false);
});

test('future reports publish only the canonical certification matrix binding', () => {
  const firstSerial = 'private-diagnostic-a';
  const secondSerial = 'private-diagnostic-b';
  const child = run(
    '--dry-run',
    '--diagnostic-handheld-pair',
    '--handheld-a-serial',
    firstSerial,
    '--handheld-b-serial',
    secondSerial
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(
    report.certificationMatrixBinding,
    ADVANCED_CERTIFICATION_TARGETS_BINDING
  );
  assert.match(
    report.certificationMatrixBinding.matrixSha256,
    /^[0-9a-f]{64}$/u
  );
  assert.deepEqual(
    Object.keys(report.certificationMatrixBinding.matrix.roles).sort(),
    ['handheld', 'station']
  );
  assert.equal(child.stdout.includes(firstSerial), false);
  assert.equal(child.stdout.includes(secondSerial), false);
});

test('cooldown pilot is fixed to 20 cycles and at least 31 seconds of quiescence', () => {
  const firstSerial = 'offline-pilot-a';
  const secondSerial = 'offline-pilot-b';
  const child = run(
    '--dry-run',
    '--diagnostic-cooldown-pilot',
    '--handheld-a-serial',
    firstSerial,
    '--handheld-b-serial',
    secondSerial
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(
    report.source,
    'V5BT_B2_ANDROID_HANDHELD_PAIR_COOLDOWN_PILOT'
  );
  assert.equal(report.mode, 'DRY_RUN_DIAGNOSTIC_COOLDOWN_PILOT');
  assert.equal(report.requestedCycles, 20);
  assert.equal(report.cycleGapMs, null);
  assert.equal(report.evidenceClass, 'NON_GATE_EVIDENCE');
  assert.equal(report.b2PromotionAllowed, false);
  assert.equal(report.certificationEligible, false);
  assert.equal(report.formalCertificationCyclesUnaffected, 100);
  assert.deepEqual(report.pilotContract, {
    purpose: 'MEASURE_DISCOVERY_AFTER_FULL_RADIO_COOLDOWN',
    requiredCycles: 20,
    requiredInitialQuiescenceIntervals: 1,
    requiredInterCycleIntervals: 19,
    requiredTotalQuiescenceIntervals: 20,
    configuredQuiescenceMs: 31_000,
    requiredMinimumQuiescenceMs: 31_000,
    fixedCycleCountCannotSatisfyFormalB2: true,
    promotionProhibited: true
  });
  assert.deepEqual(report.timingConfiguration, {
    timeoutMs: 15_000,
    pollMs: 250,
    cycleGapMs: null,
    quiescenceMs: 31_000,
    quiescenceClock: 'HOST_MONOTONIC',
    quiescenceStartsAfterBothForceStops: true,
    requiredMinimumQuiescenceMs: 31_000,
    latencyClockOrigin: 'CYCLE_LAUNCH',
    requiredMaximumP95Ms: 8_000
  });
  assert.equal(child.stdout.includes(firstSerial), false);
  assert.equal(child.stdout.includes(secondSerial), false);
});

test('cooldown pilot rejects overrides that could blur the formal B2 contract', () => {
  const base = [
    '--dry-run',
    '--diagnostic-cooldown-pilot',
    '--handheld-a-serial',
    'pilot-a',
    '--handheld-b-serial',
    'pilot-b'
  ];
  for (const args of [
    ['--cycles', '20'],
    ['--cycle-gap-ms', '500'],
    ['--formal-quiescence-ms', '31000'],
    ['--diagnostic-handheld-pair']
  ]) {
    const child = run(...base, ...args);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /^COOLDOWN_PILOT_CONTRACT_INVALID:/u);
    assert.doesNotMatch(child.stderr, /ADB_DEVICE_UNAVAILABLE|COMMAND_FAILED/u);
  }

  const tooShort = run(...base, '--quiescence-ms', '30000');
  assert.equal(tooShort.status, 1);
  assert.match(tooShort.stderr, /^INVALID_ARGUMENT:/u);

  const unrelated = run('--dry-run', '--quiescence-ms', '31000');
  assert.equal(unrelated.status, 1);
  assert.match(unrelated.stderr, /^COOLDOWN_PILOT_CONTRACT_INVALID:/u);
});

test('physical cooldown pilot validates its complete contract before ADB', () => {
  const missingOutput = run(
    '--diagnostic-cooldown-pilot',
    '--handheld-a-serial',
    'pilot-a',
    '--handheld-b-serial',
    'pilot-b'
  );
  assert.equal(missingOutput.status, 1);
  assert.match(missingOutput.stderr, /^DIAGNOSTIC_OUTPUT_REQUIRED:/u);
  assert.doesNotMatch(
    missingOutput.stderr,
    /ADB_DEVICE_UNAVAILABLE|COMMAND_FAILED/u
  );

  const missingDevice = run(
    '--diagnostic-cooldown-pilot',
    '--output',
    path.join(os.tmpdir(), 'unused-b2-cooldown-pilot.json')
  );
  assert.equal(missingDevice.status, 1);
  assert.match(missingDevice.stderr, /^INVALID_ARGUMENT:/u);
  assert.doesNotMatch(
    missingDevice.stderr,
    /ADB_DEVICE_UNAVAILABLE|COMMAND_FAILED/u
  );
});

test('diagnostic mode rejects formal target and evidence inputs', () => {
  for (const args of [
    ['--station-serial', 'formal-station'],
    ['--rf-evidence', '/tmp/formal-rf'],
    ['--station-package', 'com.sentrapa.postazione.advanced']
  ]) {
    const child = run('--dry-run', '--diagnostic-handheld-pair', ...args);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /^DIAGNOSTIC_ISOLATION_INVALID:/u);
  }
});

test('diagnostic mode rejects a reused or missing handheld serial before ADB', () => {
  const reused = run(
    '--dry-run',
    '--diagnostic-handheld-pair',
    '--handheld-a-serial',
    'same-device',
    '--handheld-b-serial',
    'same-device'
  );
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, /^INVALID_ARGUMENT:/u);

  const missing = run('--diagnostic-handheld-pair', '--cycles', '1');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^INVALID_ARGUMENT:/u);
  assert.doesNotMatch(missing.stderr, /ADB_DEVICE_UNAVAILABLE|COMMAND_FAILED/u);

  const wrongCycles = run(
    '--diagnostic-handheld-pair',
    '--cycles',
    '99',
    '--handheld-a-serial',
    'diagnostic-a',
    '--handheld-b-serial',
    'diagnostic-b',
    '--output',
    path.join(os.tmpdir(), 'unused-b2-diagnostic.json')
  );
  assert.equal(wrongCycles.status, 1);
  assert.match(wrongCycles.stderr, /^DIAGNOSTIC_CYCLE_COUNT_INVALID:/u);
  assert.doesNotMatch(wrongCycles.stderr, /ADB_DEVICE_UNAVAILABLE|COMMAND_FAILED/u);

  const missingOutput = run(
    '--diagnostic-handheld-pair',
    '--handheld-a-serial',
    'diagnostic-a',
    '--handheld-b-serial',
    'diagnostic-b'
  );
  assert.equal(missingOutput.status, 1);
  assert.match(missingOutput.stderr, /^DIAGNOSTIC_OUTPUT_REQUIRED:/u);
  assert.doesNotMatch(missingOutput.stderr, /ADB_DEVICE_UNAVAILABLE|COMMAND_FAILED/u);
});

test('diagnostic evidence output is private and cannot be overwritten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v5bt-b2-output-'));
  try {
    const output = path.join(directory, 'diagnostic.json');
    const args = [
      '--dry-run',
      '--diagnostic-handheld-pair',
      '--handheld-a-serial',
      'diagnostic-a',
      '--handheld-b-serial',
      'diagnostic-b',
      '--output',
      output
    ];
    const first = run(...args);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const original = fs.readFileSync(output, 'utf8');
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.statSync(output).nlink, 1);
    const second = run(...args);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /^OUTPUT_EXISTS:/u);
    assert.equal(fs.readFileSync(output, 'utf8'), original);
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.startsWith('.b2-evidence-')),
      []
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('formal B2 dry run retains the handheld and station target pair', () => {
  const child = run('--dry-run', '--cycles', '100');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.schemaVersion, 7);
  assert.equal(report.source, 'V5BT_B2_ANDROID_GATE_HARNESS');
  assert.equal(report.scope, 'DISCOVERY_ONLY_POST_ENROLLMENT');
  assert.deepEqual(
    report.devices.map((device) => device.role),
    ['handheld', 'station']
  );
  assert.equal(report.cycleGapMs, null);
  assert.equal(report.formalQuiescenceEvidenceExpected, true);
  assert.deepEqual(report.formalQuiescenceContract, {
    purpose: 'FORMAL_DISCOVERY_AFTER_FULL_RADIO_COOLDOWN',
    requiredCycles: 100,
    requiredInitialQuiescenceIntervals: 1,
    requiredInterCycleIntervals: 99,
    requiredTotalQuiescenceIntervals: 100,
    configuredQuiescenceMs: 31_000,
    requiredMinimumQuiescenceMs: 31_000,
    clock: 'HOST_MONOTONIC',
    startsAfterBothForceStops: true,
    missingOrShortIntervalFailsClosed: true
  });
  assert.deepEqual(report.timingConfiguration, {
    timeoutMs: 15_000,
    pollMs: 250,
    cycleGapMs: null,
    quiescenceMs: 31_000,
    quiescenceClock: 'HOST_MONOTONIC',
    quiescenceStartsAfterBothForceStops: true,
    requiredMinimumQuiescenceMs: 31_000,
    requiredQuiescenceWindows: 100,
    latencyClockOrigin: 'CYCLE_LAUNCH',
    requiredMaximumP95Ms: 8_000
  });
  assert.equal(Object.hasOwn(report, 'evidenceClass'), false);
  assert.deepEqual(
    report.certificationMatrixBinding,
    ADVANCED_CERTIFICATION_TARGETS_BINDING
  );
});

test('formal B2 quiescence is configurable only above the fail-closed floor', () => {
  const configured = run(
    '--dry-run',
    '--formal-quiescence-ms',
    '45000'
  );
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  const report = JSON.parse(configured.stdout);
  assert.equal(report.formalQuiescenceContract.configuredQuiescenceMs, 45_000);
  assert.equal(report.timingConfiguration.quiescenceMs, 45_000);
  assert.equal(report.formalQuiescenceContract.requiredTotalQuiescenceIntervals, 100);

  const tooShort = run(
    '--dry-run',
    '--formal-quiescence-ms',
    '30000'
  );
  assert.equal(tooShort.status, 1);
  assert.match(tooShort.stderr, /^INVALID_ARGUMENT:/u);

  const legacyGap = run('--dry-run', '--cycle-gap-ms', '500');
  assert.equal(legacyGap.status, 1);
  assert.match(
    legacyGap.stderr,
    /^FORMAL_QUIESCENCE_CONTRACT_INVALID:/u
  );
});

test('formal quiescence cannot leak into either diagnostic mode', () => {
  const diagnostic = run(
    '--dry-run',
    '--diagnostic-handheld-pair',
    '--formal-quiescence-ms',
    '31000'
  );
  assert.equal(diagnostic.status, 1);
  assert.match(diagnostic.stderr, /^DIAGNOSTIC_ISOLATION_INVALID:/u);

  const pilot = run(
    '--dry-run',
    '--diagnostic-cooldown-pilot',
    '--handheld-a-serial',
    'pilot-a',
    '--handheld-b-serial',
    'pilot-b',
    '--formal-quiescence-ms',
    '31000'
  );
  assert.equal(pilot.status, 1);
  assert.match(pilot.stderr, /^COOLDOWN_PILOT_CONTRACT_INVALID:/u);
});
