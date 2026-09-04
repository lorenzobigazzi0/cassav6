import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { hashPin, verifyPin, verifyPinAsync } from "../backend/auth/password.js";

const verificationCount = Math.max(
  1,
  Math.min(100, Math.trunc(Number(process.env.PIN_BENCH_COUNT) || 13)),
);
const pin = "benchmark-pin";
const pinHash = hashPin(pin);

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function milliseconds(nanoseconds) {
  const value = Number(nanoseconds) / 1_000_000;
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

async function measure(mode, operation) {
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  await delay(30);
  const cpuStartedAt = process.cpuUsage();
  const wallStartedAt = performance.now();
  const results = await operation();
  const wallMs = performance.now() - wallStartedAt;
  const cpu = process.cpuUsage(cpuStartedAt);
  await delay(30);
  eventLoop.disable();
  if (!results.every((value) => value === true)) {
    throw new Error(`Verifica ${mode} non valida.`);
  }
  return {
    mode,
    count: results.length,
    wallMs: Math.round(wallMs * 100) / 100,
    cpuUserMs: Math.round(cpu.user / 10) / 100,
    cpuSystemMs: Math.round(cpu.system / 10) / 100,
    eventLoopMeanMs: milliseconds(eventLoop.mean),
    eventLoopP95Ms: milliseconds(eventLoop.percentile(95)),
    eventLoopMaxMs: milliseconds(eventLoop.max),
  };
}

const synchronous = await measure("sync", async () =>
  Array.from({ length: verificationCount }, () => verifyPin(pin, pinHash)),
);
const asynchronous = await measure("async", () =>
  Promise.all(Array.from({ length: verificationCount }, () => verifyPinAsync(pin, pinHash))),
);

process.stdout.write(`${JSON.stringify({ verificationCount, synchronous, asynchronous }, null, 2)}\n`);
