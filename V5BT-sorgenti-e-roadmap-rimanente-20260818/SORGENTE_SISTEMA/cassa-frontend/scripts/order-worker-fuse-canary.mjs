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

const runId = envString("CANARY_RUN_ID", `orderfuse_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);

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
      Accept: "application/json",
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
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    bytes: Buffer.byteLength(text),
    bodyPreview: text.slice(0, 500),
  };
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# Canary order worker fuse ${runId}`,
    "",
    `Data: ${new Date().toISOString()}`,
    "",
    "## Configurazione",
    "",
    `- frontend origin: ${options.frontendOrigin}`,
    `- worker origin: ${options.workerOrigin}`,
    "",
    "## Esito",
    "",
    `- order mutation via proxy resta owner: ${result.proxyOrderMutationToOwner ? "yes" : "no"}`,
    `- order mutation diretta su worker bloccata: ${result.directWorkerMutationBlocked ? "yes" : "no"}`,
    `- proxy status: ${result.proxyOrderMutation.status}`,
    `- proxy role: ${result.proxyOrderMutation.proxyRole || "n.d."}`,
    `- worker status: ${result.directWorkerMutation.status}`,
    "",
  ];
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  console.log(`[order-fuse-canary] frontend=${options.frontendOrigin} worker=${options.workerOrigin}`);
  const proxyOrderMutation = await requestProbe(options.frontendOrigin, "/api/integration/orders/create", {
    method: "POST",
    body: {
      canary: true,
      invalid: true,
      reason: "order-worker-fuse-canary-no-side-effect",
    },
  });
  const directWorkerMutation = await requestProbe(options.workerOrigin, "/api/integration/orders/create", {
    method: "POST",
    body: {
      canary: true,
      invalid: true,
      reason: "order-worker-fuse-canary-direct-worker-block",
    },
  });

  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options,
    proxyOrderMutation,
    directWorkerMutation,
    proxyOrderMutationToOwner: proxyOrderMutation.proxyRole === "api-owner",
    directWorkerMutationBlocked:
      directWorkerMutation.status === 503 &&
      /BACKEND_PROCESS_ROUTE_BLOCKED/.test(directWorkerMutation.bodyPreview),
  };
  const reportDir = path.join(options.reportRoot, `order-worker-fuse-canary-${runId}`);
  await writeReport(reportDir, result);
  console.log(`[order-fuse-canary] report=${reportDir}`);
  console.log(
    `[order-fuse-canary] proxyOwner=${result.proxyOrderMutationToOwner} directWorkerBlocked=${result.directWorkerMutationBlocked} proxyStatus=${proxyOrderMutation.status} workerStatus=${directWorkerMutation.status}`,
  );

  if (!result.proxyOrderMutationToOwner || !result.directWorkerMutationBlocked) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[order-fuse-canary] errore", error);
  process.exitCode = 1;
});
