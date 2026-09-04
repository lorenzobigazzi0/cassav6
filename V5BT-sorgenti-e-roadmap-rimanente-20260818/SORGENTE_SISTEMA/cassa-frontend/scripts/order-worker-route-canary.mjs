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

function parseRouteKey(value, fallback) {
  const text = envString(value, fallback);
  const match = /^([A-Za-z]+)\s+(\S+)$/.exec(text);
  if (!match) {
    throw new Error(`${value} deve essere nel formato "METHOD /path"`);
  }
  return {
    key: `${match[1].toUpperCase()} ${match[2]}`,
    method: match[1].toUpperCase(),
    path: match[2],
  };
}

const targetRoute = parseRouteKey(
  "CANARY_ORDER_WORKER_ROUTE_KEY",
  "POST /api/integration/orders/sync",
);
const controlRoute = parseRouteKey(
  "CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY",
  "POST /api/integration/orders/create",
);

const options = {
  frontendOrigin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  workerOrigin: envString("CANARY_API_WORKER_ORIGIN", "http://127.0.0.1:5283").replace(/\/+$/, ""),
  timeoutMs: parseIntEnv("CANARY_TIMEOUT_MS", 10_000, { min: 1_000, max: 120_000 }),
  reportRoot: envString("CANARY_REPORT_ROOT", path.join(repoRoot, "logs")),
  insecureTls: String(process.env.CANARY_INSECURE_TLS ?? "1") !== "0",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString("CANARY_RUN_ID", `orderroute_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);

async function fetchWithTimeout(url, init = {}, timeoutMs = options.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestProbe(origin, route, bodyReason) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${origin}${route.path}`, {
    method: route.method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      canary: true,
      invalid: true,
      reason: bodyReason,
      route: route.key,
    }),
  });
  const text = await response.text();
  return {
    key: route.key,
    status: response.status,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    bytes: Buffer.byteLength(text),
    bodyPreview: text.slice(0, 500),
  };
}

function isProcessRouteBlocked(probe) {
  return probe.status === 503 && /BACKEND_PROCESS_ROUTE_BLOCKED/.test(probe.bodyPreview);
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# Canary order worker route ${runId}`,
    "",
    `Data: ${new Date().toISOString()}`,
    "",
    "## Configurazione",
    "",
    `- frontend origin: ${options.frontendOrigin}`,
    `- worker origin: ${options.workerOrigin}`,
    `- target route: ${targetRoute.key}`,
    `- control route: ${controlRoute.key}`,
    "",
    "## Esito",
    "",
    `- proxy target su api-worker: ${result.proxyTargetToWorker ? "yes" : "no"}`,
    `- proxy control su api-owner: ${result.proxyControlToOwner ? "yes" : "no"}`,
    `- worker target non bloccato dal route guard: ${result.directWorkerTargetAllowed ? "yes" : "no"}`,
    `- worker control bloccato dal route guard: ${result.directWorkerControlBlocked ? "yes" : "no"}`,
    "",
  ];
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  console.log(
    `[order-route-canary] frontend=${options.frontendOrigin} worker=${options.workerOrigin} target=${targetRoute.key}`,
  );
  const proxyTarget = await requestProbe(
    options.frontendOrigin,
    targetRoute,
    "order-worker-route-canary-target",
  );
  const proxyControl = await requestProbe(
    options.frontendOrigin,
    controlRoute,
    "order-worker-route-canary-control",
  );
  const directWorkerTarget = await requestProbe(
    options.workerOrigin,
    targetRoute,
    "order-worker-route-canary-direct-target",
  );
  const directWorkerControl = await requestProbe(
    options.workerOrigin,
    controlRoute,
    "order-worker-route-canary-direct-control",
  );

  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options,
    targetRoute,
    controlRoute,
    proxyTarget,
    proxyControl,
    directWorkerTarget,
    directWorkerControl,
    proxyTargetToWorker: proxyTarget.proxyRole === "api-worker",
    proxyControlToOwner: proxyControl.proxyRole === "api-owner",
    directWorkerTargetAllowed: !isProcessRouteBlocked(directWorkerTarget),
    directWorkerControlBlocked: isProcessRouteBlocked(directWorkerControl),
  };
  const reportDir = path.join(options.reportRoot, `order-worker-route-canary-${runId}`);
  await writeReport(reportDir, result);
  console.log(`[order-route-canary] report=${reportDir}`);
  console.log(
    `[order-route-canary] proxyTargetWorker=${result.proxyTargetToWorker} proxyControlOwner=${result.proxyControlToOwner} directTargetAllowed=${result.directWorkerTargetAllowed} directControlBlocked=${result.directWorkerControlBlocked}`,
  );

  if (
    !result.proxyTargetToWorker ||
    !result.proxyControlToOwner ||
    !result.directWorkerTargetAllowed ||
    !result.directWorkerControlBlocked
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[order-route-canary] errore", error);
  process.exitCode = 1;
});
