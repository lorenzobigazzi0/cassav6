import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cassaRoot, "..");

function envString(name, fallback) {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function parseIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

const options = {
  frontendOrigin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  workerOrigin: envString("CANARY_API_WORKER_ORIGIN", "http://127.0.0.1:5283").replace(/\/+$/, ""),
  iterations: parseIntEnv("CANARY_READ_ITERATIONS", 5, { min: 1, max: 100 }),
  concurrency: parseIntEnv("CANARY_READ_CONCURRENCY", 1, { min: 1, max: 64 }),
  durationMs: parseIntEnv("CANARY_READ_DURATION_MS", 0, { min: 0, max: 300_000 }),
  delayMs: parseIntEnv("CANARY_READ_DELAY_MS", 0, { min: 0, max: 10_000 }),
  maxProbes: parseIntEnv("CANARY_READ_MAX_PROBES", 5_000, { min: 1, max: 50_000 }),
  timeoutMs: parseIntEnv("CANARY_TIMEOUT_MS", 10_000, { min: 1_000, max: 120_000 }),
  expectedOrderMutationProxyRole: envString("CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE", "api-owner"),
  expectDirectWorkerMutationBlocked: envBool("CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED", true),
  reportRoot: envString("CANARY_REPORT_ROOT", path.join(repoRoot, "logs")),
  insecureTls: String(process.env.CANARY_INSECURE_TLS ?? "1") !== "0",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString("CANARY_RUN_ID", `apiw_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);

const readPaths = [
  "/api/health",
  "/api/integration/menu",
  "/api/integration/layout",
  "/api/integration/stations/active",
  "/api/integration/stations/state",
  "/api/integration/waiters",
];

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function roundMs(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}

function percentile(values, p) {
  const clean = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return clean[index];
}

async function fetchWithTimeout(url, init = {}, timeoutMs = options.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestProbe(origin, pathname, init = {}) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${origin}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: init.accept ?? "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return {
    pathname,
    method: init.method ?? "GET",
    status: response.status,
    durationMs: performance.now() - startedAt,
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    bytes: Buffer.byteLength(text),
    bodyPreview: text.slice(0, 300),
  };
}

async function probeSseReady() {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, 3_000));
  try {
    const response = await fetch(`${options.frontendOrigin}/api/integration/notifications/stream?consumer=${runId}&clientApp=mobile-frontend`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
    }
    controller.abort();
    return {
      pathname: "/api/integration/notifications/stream",
      method: "GET",
      status: response.status,
      durationMs: performance.now() - startedAt,
      proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
      bytes: Buffer.byteLength(buffer),
      bodyPreview: buffer.slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function assertProbe(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function summarize(probes) {
  const durations = probes.map((probe) => probe.durationMs);
  const byRole = probes.reduce((accumulator, probe) => {
    const role = probe.proxyRole || "none";
    accumulator[role] = (accumulator[role] ?? 0) + 1;
    return accumulator;
  }, {});
  return {
    count: probes.length,
    p50Ms: roundMs(percentile(durations, 50)),
    p95Ms: roundMs(percentile(durations, 95)),
    maxMs: roundMs(durations.length ? Math.max(...durations) : null),
    byRole,
  };
}

function probeBasePath(probe) {
  return String(probe?.pathname ?? "").split("?")[0] || "";
}

function validateReadProbe(probe, errors) {
  const pathname = probeBasePath(probe);
  if (pathname === "/api/health") {
    if (probe.proxyRole !== "api-owner") {
      errors.push({ pathname, reason: "health deve restare local-control/owner", probe });
    }
  } else if (probe.proxyRole !== "api-worker") {
    errors.push({ pathname, reason: "read non instradata ad api-worker", probe });
  }
  if (probe.status < 200 || probe.status >= 300) {
    errors.push({ pathname, reason: "read status non 2xx", probe });
  }
}

async function buildFixedReadProbes() {
  const jobs = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    for (const pathname of readPaths) {
      jobs.push({ iteration, pathname });
    }
  }
  return mapLimit(jobs, options.concurrency, async ({ iteration, pathname }, index) => {
    try {
      return await requestProbe(
        options.frontendOrigin,
        `${pathname}${pathname.includes("?") ? "&" : "?"}_=${Date.now()}_${iteration}_${index}`,
      );
    } catch (error) {
      return {
        pathname,
        method: "GET",
        status: 0,
        durationMs: null,
        proxyRole: "",
        desiredProxyRole: "",
        contentType: "",
        bytes: 0,
        bodyPreview: error?.message ?? String(error),
      };
    }
  });
}

async function buildDurationReadProbes() {
  const probes = [];
  let cursor = 0;
  const deadline = performance.now() + options.durationMs;
  async function durationWorker(workerIndex) {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= options.maxProbes || performance.now() >= deadline) return;
      const pathname = readPaths[index % readPaths.length];
      try {
        probes.push(
          await requestProbe(
            options.frontendOrigin,
            `${pathname}${pathname.includes("?") ? "&" : "?"}_=${Date.now()}_${workerIndex}_${index}`,
          ),
        );
      } catch (error) {
        probes.push({
          pathname,
          method: "GET",
          status: 0,
          durationMs: null,
          proxyRole: "",
          desiredProxyRole: "",
          contentType: "",
          bytes: 0,
          bodyPreview: error?.message ?? String(error),
        });
      }
      await delay(options.delayMs);
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => durationWorker(index)));
  return probes;
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# Canary API worker reads ${runId}`,
    "",
    `Data: ${new Date().toISOString()}`,
    "",
    "## Configurazione",
    "",
    `- frontend origin: ${options.frontendOrigin}`,
    `- worker origin: ${options.workerOrigin}`,
    `- iterazioni: ${options.iterations}`,
    `- concorrenza: ${options.concurrency}`,
    `- durata: ${options.durationMs}ms`,
    `- delay: ${options.delayMs}ms`,
    `- max probe: ${options.maxProbes}`,
    `- expected order mutation proxy role: ${options.expectedOrderMutationProxyRole}`,
    `- expected direct worker mutation blocked: ${options.expectDirectWorkerMutationBlocked ? "yes" : "no"}`,
    "",
    "## Esito",
    "",
    `- read proxy api-worker: ${result.readsToWorker}/${result.expectedReadsToWorker}`,
    `- mutation proxy role expected: ${result.mutationProxyRoleAsExpected ? "yes" : "no"} (${result.mutationViaProxy.proxyRole || "none"})`,
    `- direct worker mutation blocked expected: ${result.directWorkerMutationAsExpected ? "yes" : "no"} (${result.directWorkerMutation.status})`,
    `- SSE proxy realtime-gateway: ${result.sseToRealtime ? "yes" : "no"}`,
    `- read p95: ${result.summary.p95Ms ?? "n.d."}ms`,
    `- ruoli read: ${JSON.stringify(result.summary.byRole)}`,
    "",
  ];
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  const probes = [];
  const errors = [];
  console.log(`[api-worker-canary] frontend=${options.frontendOrigin} worker=${options.workerOrigin} iterations=${options.iterations} concurrency=${options.concurrency} durationMs=${options.durationMs} delayMs=${options.delayMs}`);

  const directHealth = await requestProbe(options.workerOrigin, "/api/health");
  assertProbe(directHealth.status === 200, "api-worker diretto non raggiungibile", directHealth);

  const completed = options.durationMs > 0 ? await buildDurationReadProbes() : await buildFixedReadProbes();
  for (const probe of completed) {
    probes.push(probe);
    validateReadProbe(probe, errors);
  }

  const mutationViaProxy = await requestProbe(options.frontendOrigin, "/api/integration/orders/create", {
    method: "POST",
    body: {},
  });
  const directWorkerMutation = await requestProbe(options.workerOrigin, "/api/integration/orders/create", {
    method: "POST",
    body: {},
  });
  const sseProbe = await probeSseReady();

  const expectedReadsToWorker = probes.filter((probe) => probeBasePath(probe) !== "/api/health").length;
  const readsToWorker = probes.filter((probe) => probeBasePath(probe) !== "/api/health" && probe.proxyRole === "api-worker").length;
  const mutationToOwner = mutationViaProxy.proxyRole === "api-owner" && mutationViaProxy.status !== 503;
  const mutationProxyRoleAsExpected =
    mutationViaProxy.proxyRole === options.expectedOrderMutationProxyRole &&
    mutationViaProxy.status !== 503;
  const directWorkerMutationBlocked =
    directWorkerMutation.status === 503 && /BACKEND_PROCESS_ROUTE_BLOCKED/.test(directWorkerMutation.bodyPreview);
  const directWorkerMutationAsExpected =
    options.expectDirectWorkerMutationBlocked
      ? directWorkerMutationBlocked
      : !directWorkerMutationBlocked && directWorkerMutation.status !== 503;
  const sseToRealtime = sseProbe.proxyRole === "realtime-gateway" && sseProbe.status === 200;

  const result = {
    runId,
    options,
    directHealth,
    probes,
    mutationViaProxy,
    directWorkerMutation,
    sseProbe,
    readsToWorker,
    expectedReadsToWorker,
    mutationToOwner,
    mutationProxyRoleAsExpected,
    directWorkerMutationBlocked,
    directWorkerMutationAsExpected,
    sseToRealtime,
    summary: summarize(probes),
    errors,
  };

  const reportDir = path.join(options.reportRoot, `api-worker-read-canary-${runId}`);
  await writeReport(reportDir, result);
  console.log(`[api-worker-canary] report=${reportDir}`);
  console.log(`[api-worker-canary] readsToWorker=${readsToWorker}/${expectedReadsToWorker} readP95=${result.summary.p95Ms ?? "n.d."}ms roles=${JSON.stringify(result.summary.byRole)}`);
  console.log(`[api-worker-canary] mutationRole=${mutationViaProxy.proxyRole || "none"} expected=${options.expectedOrderMutationProxyRole} directWorkerBlocked=${directWorkerMutationBlocked} expectedBlocked=${options.expectDirectWorkerMutationBlocked} sseToRealtime=${sseToRealtime}`);

  if (
    errors.length > 0 ||
    readsToWorker !== expectedReadsToWorker ||
    !mutationProxyRoleAsExpected ||
    !directWorkerMutationAsExpected ||
    !sseToRealtime
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[api-worker-canary] errore", error, error?.details ?? "");
  process.exitCode = 1;
});
