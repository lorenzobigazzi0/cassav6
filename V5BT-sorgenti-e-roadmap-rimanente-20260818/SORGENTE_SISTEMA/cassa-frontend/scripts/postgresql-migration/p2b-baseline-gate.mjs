import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CASSA_ROOT = path.resolve(SCRIPT_DIR, "../..");
const MOBILE_ROOT = path.resolve(CASSA_ROOT, "../mobile-frontend");
const DEFAULT_ALLOWLIST = path.join(SCRIPT_DIR, "p2b-baseline-allowlist.json");
const REPORTER = path.join(SCRIPT_DIR, "p2b-node-test-reporter.mjs");

function normalizedFile(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

export function failureKey(entry) {
  return normalizedFile(entry.file) + "::" + String(entry.name ?? "");
}

export function compareBaseline(expectedSuite, actualSuite) {
  const expectedFailures = expectedSuite?.knownFailures ?? [];
  const actualFailures = actualSuite?.failures ?? [];
  const expectedKeys = expectedFailures.map(failureKey);
  const actualKeys = actualFailures.map(failureKey);
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  const duplicateExpected = expectedKeys.filter((key, index) => expectedKeys.indexOf(key) !== index);
  const duplicateActual = actualKeys.filter((key, index) => actualKeys.indexOf(key) !== index);
  const missingKnownFailures = expectedKeys.filter((key) => !actualSet.has(key));
  const unexpectedFailures = actualKeys.filter((key) => !expectedSet.has(key));
  const expectedCounts = expectedSuite?.expected ?? {};
  const actualCounts = actualSuite?.counts ?? {};
  const countDrift = ["total", "passed", "failed"]
    .filter((key) => Number(expectedCounts[key]) !== Number(actualCounts[key]))
    .map((key) => ({
      metric: key,
      expected: Number(expectedCounts[key]),
      actual: Number(actualCounts[key]),
    }));

  return {
    ok:
      duplicateExpected.length === 0 &&
      duplicateActual.length === 0 &&
      missingKnownFailures.length === 0 &&
      unexpectedFailures.length === 0 &&
      countDrift.length === 0,
    duplicateExpected,
    duplicateActual,
    missingKnownFailures,
    unexpectedFailures,
    countDrift,
  };
}

export function parseNodeTestReport(stdout) {
  const events = String(stdout ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const failures = events
    .filter((event) => event.type === "test:fail" && event.detailsType === "test")
    .map(({ file, name }) => ({ file: normalizedFile(file), name }));
  const summaries = events.filter((event) => event.type === "test:summary" && event.counts);
  const counts = summaries
    .map(({ counts: entry }) => entry)
    .sort((left, right) => Number(right.tests) - Number(left.tests))[0];
  if (!counts) throw new Error("Riepilogo node:test non trovato.");
  return {
    counts: {
      total: Number(counts.tests),
      passed: Number(counts.passed),
      failed: Number(counts.failed),
    },
    failures,
  };
}

export function parseVitestReport(stdout, mobileRoot = MOBILE_ROOT) {
  const report = JSON.parse(String(stdout ?? "").trim());
  const failures = (report.testResults ?? []).flatMap((suite) => {
    const file = normalizedFile(path.relative(mobileRoot, suite.name));
    return (suite.assertionResults ?? [])
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => ({ file, name: assertion.fullName }));
  });
  return {
    counts: {
      total: Number(report.numTotalTests),
      passed: Number(report.numPassedTests),
      failed: Number(report.numFailedTests),
    },
    failures,
  };
}

function executeNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function runCassaBaseline() {
  const entries = await readdir(path.join(CASSA_ROOT, "frontend-tests"), { withFileTypes: true });
  const testFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(CASSA_ROOT, "frontend-tests", entry.name))
    .sort();
  const execution = await executeNode(
    ["--test", "--test-reporter=" + pathToFileURL(REPORTER).href, ...testFiles],
    CASSA_ROOT,
  );
  return {
    ...parseNodeTestReport(execution.stdout),
    runnerExitStatus: execution.status,
    runnerSignal: execution.signal,
    stderr: execution.stderr.trim(),
  };
}

async function runMobileBaseline() {
  const execution = await executeNode(
    [path.join(MOBILE_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=json"],
    MOBILE_ROOT,
  );
  return {
    ...parseVitestReport(execution.stdout),
    runnerExitStatus: execution.status,
    runnerSignal: execution.signal,
    stderr: execution.stderr.trim(),
  };
}

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 && argv[index + 1] ? path.resolve(CASSA_ROOT, argv[index + 1]) : null;
}

export async function runP2bBaselineGate({
  allowlistPath = DEFAULT_ALLOWLIST,
  outputPath = null,
} = {}) {
  const allowlist = JSON.parse(await readFile(allowlistPath, "utf8"));
  const startedAt = Date.now();
  const [cassa, mobile] = await Promise.all([
    runCassaBaseline(),
    runMobileBaseline(),
  ]);
  const comparisons = {
    "cassa-frontend": compareBaseline(allowlist.suites["cassa-frontend"], cassa),
    "mobile-frontend": compareBaseline(allowlist.suites["mobile-frontend"], mobile),
  };
  const ok = Object.values(comparisons).every((comparison) => comparison.ok);
  const report = {
    schemaVersion: 1,
    gate: "P2b-exact-known-failure-set",
    ok,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    policy: allowlist.policy,
    suites: {
      "cassa-frontend": {
        counts: cassa.counts,
        runnerExitStatus: cassa.runnerExitStatus,
        failures: cassa.failures,
        comparison: comparisons["cassa-frontend"],
      },
      "mobile-frontend": {
        counts: mobile.counts,
        runnerExitStatus: mobile.runnerExitStatus,
        failures: mobile.failures,
        comparison: comparisons["mobile-frontend"],
      },
    },
  };
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  return report;
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const report = await runP2bBaselineGate({ outputPath: outputArgument(process.argv.slice(2)) });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
