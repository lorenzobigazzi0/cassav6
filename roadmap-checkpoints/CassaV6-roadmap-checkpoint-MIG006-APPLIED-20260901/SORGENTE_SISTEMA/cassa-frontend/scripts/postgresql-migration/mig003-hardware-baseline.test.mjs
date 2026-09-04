import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMig003Evidence,
  parseMeminfo,
  parseProcessTable,
  parseTemperature,
  summarizeProcesses,
  summarizeSamples,
} from "./mig003-hardware-baseline.mjs";

test("does not report a temperature when Raspberry probes are unavailable", () => {
  assert.equal(parseTemperature(null, null), null);
  assert.equal(parseTemperature("", ""), null);
  assert.equal(parseTemperature("temp=48.5'C", null), 48.5);
  assert.equal(parseTemperature(null, "51234"), 51.234);
});

test("parses Linux memory values as bytes", () => {
  assert.deepEqual(parseMeminfo([
    "MemTotal:        4096000 kB",
    "MemFree:          512000 kB",
    "MemAvailable:    2048000 kB",
    "SwapTotal:       1024000 kB",
    "SwapFree:         768000 kB",
  ].join("\n")), {
    totalBytes: 4_194_304_000,
    availableBytes: 2_097_152_000,
    freeBytes: 524_288_000,
    swapTotalBytes: 1_048_576_000,
    swapFreeBytes: 786_432_000,
  });
});

test("aggregates RSS without retaining process command arguments", () => {
  const processes = parseProcessTable([
    "101 MainThread /usr/local/bin/node 1000 5000 2.5",
    "102 MainThread /usr/local/bin/node 2000 6000 1.5",
    "201 mariadbd - 3000 9000 3.0",
  ].join("\n"));
  const summary = summarizeProcesses(processes);

  assert.equal(summary.node.processCount, 2);
  assert.equal(summary.node.rssBytes, 3_072_000);
  assert.equal(summary.mariaDb.rssBytes, 3_072_000);
  assert.deepEqual(Object.keys(processes[0]).sort(), [
    "command", "cpuPercent", "pid", "rssBytes", "virtualBytes",
  ]);
});

test("summarizes the worst resource values across samples", () => {
  const processTemplate = {
    node: { rssBytes: 0 },
    mariaDb: { rssBytes: 0 },
    postgresql: { rssBytes: 0 },
  };
  const summary = summarizeSamples([
    {
      memory: { availableBytes: 800 },
      processes: {
        ...processTemplate,
        node: { rssBytes: 100 },
        mariaDb: { rssBytes: 200 },
      },
      temperatureCelsius: 48,
    },
    {
      memory: { availableBytes: 600 },
      processes: {
        ...processTemplate,
        node: { rssBytes: 150 },
        mariaDb: { rssBytes: 180 },
      },
      temperatureCelsius: 52,
    },
  ]);

  assert.equal(summary.nodeMaxRssBytes, 150);
  assert.equal(summary.mariaDbMaxRssBytes, 200);
  assert.equal(summary.maximumTemperatureCelsius, 52);
  assert.equal(summary.minimumAvailableMemoryBytes, 600);
});

test("accepts only complete evidence captured on a real Raspberry", () => {
  const evidence = {
    host: { platform: "linux", architecture: "arm64", model: "Raspberry Pi 5 Model B" },
    samples: [{
      memory: { totalBytes: 8_000_000_000 },
      processInventoryAvailable: true,
    }],
    summary: {
      nodeMaxRssBytes: 200_000_000,
      mariaDbMaxRssBytes: 300_000_000,
      maximumTemperatureCelsius: 55,
    },
    sqlite: { available: true, files: [{}, {}] },
    storage: { lsblk: {}, findmnt: {} },
  };

  assert.equal(evaluateMig003Evidence(evidence).validForMig003, true);
  evidence.host.platform = "win32";
  const rejected = evaluateMig003Evidence(evidence);
  assert.equal(rejected.validForMig003, false);
  assert.ok(rejected.failedChecks.includes("linux"));
});
