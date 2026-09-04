import assert from "node:assert/strict";
import test from "node:test";

import {
  compareBaseline,
  parseNodeTestReport,
  parseVitestReport,
} from "./p2b-baseline-gate.mjs";

const expectedSuite = {
  expected: { total: 2, passed: 1, failed: 1 },
  knownFailures: [{ file: "tests/a.test.mjs", name: "known", reason: "legacy" }],
};
const actualSuite = {
  counts: { total: 2, passed: 1, failed: 1 },
  failures: [{ file: "tests/a.test.mjs", name: "known" }],
};

test("gate P2b accetta solo lo stesso insieme esatto di failure", () => {
  assert.equal(compareBaseline(expectedSuite, actualSuite).ok, true);

  const newRed = structuredClone(actualSuite);
  newRed.counts = { total: 3, passed: 1, failed: 2 };
  newRed.failures.push({ file: "tests/b.test.mjs", name: "regression" });
  const comparison = compareBaseline(expectedSuite, newRed);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.unexpectedFailures, ["tests/b.test.mjs::regression"]);
  assert.deepEqual(comparison.countDrift.map(({ metric }) => metric), ["total", "failed"]);
});

test("gate P2b segnala anche una failure nota scomparsa", () => {
  const fixedWithoutAllowlistUpdate = {
    counts: { total: 2, passed: 2, failed: 0 },
    failures: [],
  };
  const comparison = compareBaseline(expectedSuite, fixedWithoutAllowlistUpdate);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missingKnownFailures, ["tests/a.test.mjs::known"]);
});

test("parser node:test sceglie il riepilogo globale", () => {
  const report = parseNodeTestReport([
    JSON.stringify({
      type: "test:fail",
      file: "frontend-tests/a.test.mjs",
      name: "known",
      detailsType: "test",
    }),
    JSON.stringify({
      type: "test:summary",
      counts: { tests: 1, passed: 0, failed: 1 },
    }),
    JSON.stringify({
      type: "test:summary",
      counts: { tests: 92, passed: 72, failed: 20 },
    }),
  ].join("\n"));
  assert.deepEqual(report.counts, { total: 92, passed: 72, failed: 20 });
  assert.deepEqual(report.failures, [{
    file: "frontend-tests/a.test.mjs",
    name: "known",
  }]);
});

test("parser Vitest usa file relativo e fullName", () => {
  const report = parseVitestReport(JSON.stringify({
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    testResults: [{
      name: "C:/mobile/tests/static/a.test.ts",
      assertionResults: [
        { status: "passed", fullName: "suite green" },
        { status: "failed", fullName: "suite known red" },
      ],
    }],
  }), "C:/mobile");
  assert.deepEqual(report, {
    counts: { total: 2, passed: 1, failed: 1 },
    failures: [{ file: "tests/static/a.test.ts", name: "suite known red" }],
  });
});
