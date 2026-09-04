import { createReadStream, existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { Agent as HttpAgent, createServer as createHttpServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, createServer as createHttpsServer, request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouteRegistry } from "./cassa-frontend/backend/core/router.js";
import { resolveBackendProxyRouteTargetRole } from "./cassa-frontend/backend/core/process-topology.js";
import { buildRouteRegistry } from "./cassa-frontend/backend/routes/index.js";

const HOST = process.env.FRONTEND_HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.FRONTEND_PORT ?? "5380", 10);
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:5381";
const BACKEND_REALTIME_ORIGIN = process.env.BACKEND_REALTIME_ORIGIN ?? "";
const BACKEND_API_WORKER_ORIGIN =
  process.env.BACKEND_API_WORKER_ORIGIN ?? process.env.BACKEND_READ_ORIGIN ?? "";
const BACKEND_TABLE_LOCK_WORKER_ORIGIN = process.env.BACKEND_TABLE_LOCK_WORKER_ORIGIN ?? "";
const BATTERY_ORIGIN = process.env.BATTERY_ORIGIN ?? "http://127.0.0.1:8865";
const FRONTEND_HTTPS_ENABLED =
  process.env.FRONTEND_HTTPS === "true" || process.env.FRONTEND_LAN_HTTPS === "true";
const FRONTEND_LAN_IP = process.env.FRONTEND_LAN_IP ?? "192.168.0.67";
const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.FRONTEND_ROOT ?? DEFAULT_ROOT);
const PROJECT_IMG_DIR = path.resolve(process.env.PROJECT_IMG_DIR ?? path.join(ROOT, "img"));
const DEFAULT_HTTPS_CERT = path.join(ROOT, "mobile-frontend", "certs", `${FRONTEND_LAN_IP}.pem`);
const DEFAULT_HTTPS_KEY = path.join(ROOT, "mobile-frontend", "certs", `${FRONTEND_LAN_IP}-key.pem`);
const FRONTEND_HTTPS_CERT = path.resolve(process.env.FRONTEND_HTTPS_CERT ?? DEFAULT_HTTPS_CERT);
const FRONTEND_HTTPS_KEY = path.resolve(process.env.FRONTEND_HTTPS_KEY ?? DEFAULT_HTTPS_KEY);
const BACKEND_URL = new URL(BACKEND_ORIGIN);
const BACKEND_REALTIME_URL = BACKEND_REALTIME_ORIGIN ? new URL(BACKEND_REALTIME_ORIGIN) : null;
// BACKEND_API_WORKER_ORIGIN accetta una lista separata da virgole per il pool
// di api-worker: il proxy bilancia in round-robin tra gli origins indicati.
const BACKEND_API_WORKER_ORIGINS = BACKEND_API_WORKER_ORIGIN
  ? BACKEND_API_WORKER_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean)
  : [];
const BACKEND_API_WORKER_URLS = BACKEND_API_WORKER_ORIGINS.map((origin) => new URL(origin));
const BACKEND_API_WORKER_URL = BACKEND_API_WORKER_URLS[0] ?? null;
const BACKEND_TABLE_LOCK_WORKER_URLS = BACKEND_TABLE_LOCK_WORKER_ORIGIN
  ? BACKEND_TABLE_LOCK_WORKER_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean).map((origin) => new URL(origin))
  : [];
const BATTERY_URL = new URL(BATTERY_ORIGIN);
const proxySocketLimit = (value, fallback, minimum = 8, maximum = 2048) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Math.max(minimum, Math.min(Number.isFinite(parsed) ? parsed : fallback, maximum));
};
const PROXY_MAX_SOCKETS = proxySocketLimit(process.env.FRONTEND_PROXY_MAX_SOCKETS, 64);
const REALTIME_PROXY_MAX_SOCKETS = proxySocketLimit(
  process.env.FRONTEND_REALTIME_PROXY_MAX_SOCKETS,
  512,
  64,
);
const proxyRequest = BACKEND_URL.protocol === "https:" ? httpsRequest : httpRequest;
const proxyAgent =
  BACKEND_URL.protocol === "https:"
    ? new HttpsAgent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS, maxFreeSockets: 16, timeout: 30000 })
    : new HttpAgent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS, maxFreeSockets: 16, timeout: 30000 });
const realtimeProxyRequest = BACKEND_REALTIME_URL?.protocol === "https:" ? httpsRequest : httpRequest;
const realtimeProxyAgent =
  BACKEND_REALTIME_URL?.protocol === "https:"
    ? new HttpsAgent({ keepAlive: true, maxSockets: REALTIME_PROXY_MAX_SOCKETS, maxFreeSockets: 32, timeout: 30000 })
    : new HttpAgent({ keepAlive: true, maxSockets: REALTIME_PROXY_MAX_SOCKETS, maxFreeSockets: 32, timeout: 30000 });
const apiWorkerProxyTargets = BACKEND_API_WORKER_URLS.map((url) => ({
  url,
  request: url.protocol === "https:" ? httpsRequest : httpRequest,
  agent:
    url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS, maxFreeSockets: 16, timeout: 30000 })
      : new HttpAgent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS, maxFreeSockets: 16, timeout: 30000 }),
}));
let apiWorkerRoundRobinIndex = 0;
function nextApiWorkerProxyTarget() {
  if (apiWorkerProxyTargets.length === 0) return null;
  const target = apiWorkerProxyTargets[apiWorkerRoundRobinIndex % apiWorkerProxyTargets.length];
  apiWorkerRoundRobinIndex = (apiWorkerRoundRobinIndex + 1) % apiWorkerProxyTargets.length;
  return target;
}
const tableLockWorkerProxyTargets = BACKEND_TABLE_LOCK_WORKER_URLS.map((url) => ({
  url,
  request: url.protocol === "https:" ? httpsRequest : httpRequest,
  agent:
    url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS, maxFreeSockets: 16, timeout: 30000 })
      : new HttpAgent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS, maxFreeSockets: 16, timeout: 30000 }),
}));
let tableLockWorkerRoundRobinIndex = 0;
function nextTableLockWorkerProxyTarget() {
  if (tableLockWorkerProxyTargets.length === 0) return null;
  const target = tableLockWorkerProxyTargets[tableLockWorkerRoundRobinIndex % tableLockWorkerProxyTargets.length];
  tableLockWorkerRoundRobinIndex = (tableLockWorkerRoundRobinIndex + 1) % tableLockWorkerProxyTargets.length;
  return target;
}
const batteryProxyRequest = BATTERY_URL.protocol === "https:" ? httpsRequest : httpRequest;
const batteryProxyAgent =
  BATTERY_URL.protocol === "https:"
    ? new HttpsAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 30000 })
    : new HttpAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 30000 });
const proxyHotGetCache = new Map();
const proxyInflightGetRequests = new Map();
const handledClientSockets = new WeakSet();
const PROXY_HOT_GET_CACHE_MAX_ENTRIES = 96;
const PROXY_HOT_GET_CACHE_MAX_BYTES = 1024 * 1024;
const PROXY_INFLIGHT_GET_MAX_WAITERS = 48;
const PROXY_SESSION_STATUS_RETRY_PATH = "/api/auth/session/status";
const PROXY_RETRY_BODY_MAX_BYTES = 1_000_000;
const PROXY_CACHE_BUSTER_PARAMS = new Set(["_", "t", "ts", "timestamp", "cacheBust", "cachebuster"]);
const BACKEND_PROXY_ROUTES = buildRouteRegistry();
const BACKEND_PROXY_ROUTE_REGISTRY = createRouteRegistry(
  BACKEND_PROXY_ROUTES,
  Object.fromEntries(
    BACKEND_PROXY_ROUTES
      .map((route) => String(route.handlerKey ?? "").trim())
      .filter(Boolean)
      .map((handlerKey) => [handlerKey, () => {}]),
  ),
);

const APPS = [
  { prefix: "/mobile", dir: path.join(ROOT, "mobile-frontend", "dist") },
  { prefix: "/cassa", dir: path.join(ROOT, "cassa-frontend", "dist") },
  { prefix: "/postazione", dir: path.join(ROOT, "postazione", "dist") },
  { prefix: "/impostazioni", dir: path.join(ROOT, "settings-frontend", "dist") },
  { prefix: "/monitor", dir: path.join(ROOT, "monitor-frontend", "dist") },
  { prefix: "/prenotazioni", dir: path.join(ROOT, "reservation-frontend", "dist") },
  { prefix: "/batteria", dir: path.join(ROOT, "battery-dashboard", "dist") },
];

const ROOT_STATIC_FILES = new Map([
  ["/mic-test.html", path.join(ROOT, "mobile-frontend", "dist", "mic-test.html")],
  ["/favicon.ico", path.join(ROOT, "mobile-frontend", "dist", "favicon.svg")],
  ["/favicon.svg", path.join(ROOT, "mobile-frontend", "dist", "favicon.svg")],
]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".avif", "image/avif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getContentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self)",
    ...extra,
  };
}

function sanitizePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isUnsafePathname(pathname) {
  const value = String(pathname ?? "");
  if (value.includes("\0")) return true;
  const lower = value.toLowerCase();
  if (lower.includes("%2e") || lower.includes("%5c")) return true;
  return value.replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

function resolveApp(pathname) {
  return APPS.find((app) => pathname === app.prefix || pathname.startsWith(`${app.prefix}/`)) ?? null;
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isRealtimeEventStreamPath(pathname) {
  const value = String(pathname ?? "");
  return (
    value === "/api/integration/notifications/stream" ||
    value === "/api/mobile/battery/stream"
  );
}

function isBatteryApiPath(pathname) {
  return pathname === "/api/battery" || pathname.startsWith("/api/battery/");
}

function resolveBackendProxyTarget(method, pathname) {
  const route = BACKEND_PROXY_ROUTE_REGISTRY.findRoute(method, pathname);
  const desiredRole = resolveBackendProxyRouteTargetRole(route, process.env);
  if (desiredRole === "realtime-gateway" && BACKEND_REALTIME_URL) {
    return {
      role: "realtime-gateway",
      desiredRole,
      url: BACKEND_REALTIME_URL,
      request: realtimeProxyRequest,
      agent: realtimeProxyAgent,
    };
  }
  if (desiredRole === "table-lock-worker" && tableLockWorkerProxyTargets.length > 0) {
    const workerTarget = nextTableLockWorkerProxyTarget();
    return {
      role: "table-lock-worker",
      desiredRole,
      poolTarget: workerTarget,
      url: workerTarget.url,
      request: workerTarget.request,
      agent: workerTarget.agent,
    };
  }
  if (desiredRole === "api-worker" && apiWorkerProxyTargets.length > 0) {
    const workerTarget = nextApiWorkerProxyTarget();
    return {
      role: "api-worker",
      desiredRole,
      poolTarget: workerTarget,
      url: workerTarget.url,
      request: workerTarget.request,
      agent: workerTarget.agent,
    };
  }
  return { role: "api-owner", desiredRole, url: BACKEND_URL, request: proxyRequest, agent: proxyAgent };
}

function resolveBackendProxyRetryTarget(target) {
  const pool =
    target.role === "api-worker"
      ? apiWorkerProxyTargets
      : target.role === "table-lock-worker"
        ? tableLockWorkerProxyTargets
        : [];
  if (pool.length === 0) return target;
  const currentIndex = pool.findIndex(
    (candidate) =>
      candidate === target.poolTarget || candidate.url.href === target.url.href,
  );
  const retryTarget = pool[(Math.max(currentIndex, 0) + 1) % pool.length];
  return {
    ...target,
    poolTarget: retryTarget,
    url: retryTarget.url,
    request: retryTarget.request,
    agent: retryTarget.agent,
  };
}

function resolveNormalizedBackendProxyRoute(method, pathname) {
  return (
    BACKEND_PROXY_ROUTE_REGISTRY.findRoute(method, pathname)?.path ??
    "/api/:unregistered"
  );
}

function isRetryableSessionStatusRequest(method, normalizedRoute) {
  return (
    String(method ?? "").toUpperCase() === "POST" &&
    normalizedRoute === PROXY_SESSION_STATUS_RETRY_PATH
  );
}

function captureProxyRequestBodyForRetry(req) {
  const chunks = [];
  let size = 0;
  let replayAvailable = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (body) => {
      if (settled) return;
      settled = true;
      resolve(body);
    };
    req.on("data", (chunk) => {
      if (!replayAvailable) return;
      size += chunk.length;
      if (size > PROXY_RETRY_BODY_MAX_BYTES) {
        replayAvailable = false;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      finish(replayAvailable ? Buffer.concat(chunks, size) : null);
    });
    req.once("aborted", () => finish(null));
    req.once("error", () => finish(null));
  });
}

function normalizedProxyErrorCode(error) {
  const code = String(error?.code ?? "UNKNOWN").trim().toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN";
}

function reportProxyUpstreamError({ method, route, targetRole, error, elapsedMs, phase }) {
  console.warn(
    JSON.stringify({
      event: "frontend_proxy_upstream_error",
      method: /^[A-Z]{1,16}$/.test(method) ? method : "UNKNOWN",
      route,
      targetRole,
      error: { code: normalizedProxyErrorCode(error) },
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      phase,
    }),
  );
}

function proxyTargetResponseHeaders(target) {
  return {
    "X-Proxy-Backend-Role": target.role,
    ...(target.desiredRole && target.desiredRole !== target.role
      ? { "X-Proxy-Backend-Desired-Role": target.desiredRole }
      : {}),
  };
}

async function resolveRootAsset(pathname) {
  const directRootFile = ROOT_STATIC_FILES.get(pathname);
  if (directRootFile) {
    if (!isInside(ROOT, directRootFile)) return null;
    try {
      const stat = await fs.stat(directRootFile);
      return stat.isFile() ? directRootFile : null;
    } catch {
      return null;
    }
  }

  if (!(pathname === "/assets" || pathname.startsWith("/assets/"))) {
    return null;
  }

  const relativePath = pathname.replace(/^\/+/, "");
  for (const app of APPS) {
    const candidate = path.resolve(app.dir, relativePath);
    if (!isInside(app.dir, candidate)) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Try next app.
    }
  }

  return null;
}

function getFrontendHttpsOptions() {
  if (!FRONTEND_HTTPS_ENABLED) {
    return null;
  }

  if (!existsSync(FRONTEND_HTTPS_CERT) || !existsSync(FRONTEND_HTTPS_KEY)) {
    throw new Error(
      [
        "Certificati HTTPS frontend mancanti.",
        "Attesi:",
        `- ${FRONTEND_HTTPS_CERT}`,
        `- ${FRONTEND_HTTPS_KEY}`,
        "Esegui da mobile-frontend: npm run cert:lan",
      ].join("\n")
    );
  }

  return {
    cert: readFileSync(FRONTEND_HTTPS_CERT),
    key: readFileSync(FRONTEND_HTTPS_KEY),
  };
}

async function resolveStaticFile(rootDir, pathname, prefix) {
  if (!(pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return null;
  }

  const relativePath = (pathname === prefix ? "" : pathname.slice(prefix.length)).replace(/^\/+/, "");
  if (!relativePath) {
    return null;
  }

  const candidate = path.resolve(rootDir, relativePath);
  if (!isInside(rootDir, candidate)) return null;

  try {
    const stat = await fs.stat(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function copyProxyHeaders(sourceHeaders, overrides = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(sourceHeaders)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return { ...headers, ...overrides };
}

function resolveProxyHotGetCacheTtlMs(method, pathname) {
  if (String(method ?? "").toUpperCase() !== "GET") {
    return 0;
  }
  const safePath = String(pathname ?? "");
  if (safePath === "/api/flags") return 5000;
  if (safePath === "/api/integration/menu") return 10000;
  if (safePath === "/api/integration/layout") return 3000;
  if (safePath === "/api/integration/stations/state") return 1000;
  if (safePath === "/api/integration/stations/active") return 1000;
  if (safePath === "/api/integration/waiters") return 2000;
  return 0;
}

function normalizeProxyCacheSearch(search) {
  const params = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  for (const key of PROXY_CACHE_BUSTER_PARAMS) {
    params.delete(key);
  }
  params.sort();
  const normalized = params.toString();
  return normalized ? `?${normalized}` : "";
}

function resolveProxyInflightGetKey(method, pathname, search) {
  if (String(method ?? "").toUpperCase() !== "GET") {
    return "";
  }
  const safePath = String(pathname ?? "");
  const coalescablePaths = new Set([
    "/api/health",
    "/api/flags",
    "/api/integration/menu",
    "/api/integration/layout",
    "/api/integration/stations/state",
    "/api/integration/stations/active",
    "/api/integration/waiters",
    "/api/integration/orders",
    "/api/integration/notifications/pull",
  ]);
  return coalescablePaths.has(safePath) ? `${safePath}${normalizeProxyCacheSearch(search)}` : "";
}

function pruneProxyHotGetCache() {
  if (proxyHotGetCache.size <= PROXY_HOT_GET_CACHE_MAX_ENTRIES) {
    return;
  }
  const entriesToDelete = proxyHotGetCache.size - PROXY_HOT_GET_CACHE_MAX_ENTRIES;
  let deleted = 0;
  for (const key of proxyHotGetCache.keys()) {
    proxyHotGetCache.delete(key);
    deleted += 1;
    if (deleted >= entriesToDelete) break;
  }
}

function sendProxyBufferedResponse(res, statusCode, headers, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.writeHead(statusCode, {
    ...headers,
    ...extraHeaders,
  });
  res.end(body);
}

function attachRequestErrorGuards(req, res) {
  req.on("error", () => {});
  res.on("error", () => {});
  attachSocketErrorGuard(req.socket);
}

function attachSocketErrorGuard(socket) {
  if (!socket || handledClientSockets.has(socket)) {
    return;
  }
  handledClientSockets.add(socket);
  socket.on("error", () => {});
}

function sendCachedProxyResponse(res, entry) {
  sendProxyBufferedResponse(res, entry.statusCode, entry.headers, entry.body, {
    "X-Proxy-Hot-Cache": "hit",
  });
}

function sendInflightProxyResponse(inflightKey, statusCode, headers, body, extraHeaders = {}) {
  const inflight = proxyInflightGetRequests.get(inflightKey);
  if (!inflight) {
    return;
  }
  proxyInflightGetRequests.delete(inflightKey);
  inflight.waiters.forEach((waiter) => {
    sendProxyBufferedResponse(waiter, statusCode, headers, body, extraHeaders);
  });
}

function sendInflightProxyError(inflightKey, error, target) {
  const inflight = proxyInflightGetRequests.get(inflightKey);
  if (!inflight) {
    return false;
  }
  proxyInflightGetRequests.delete(inflightKey);
  const body = Buffer.from(JSON.stringify({ ok: false, error: "Backend non raggiungibile." }));
  const headers = securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    ...proxyTargetResponseHeaders(target),
  });
  inflight.waiters.forEach((waiter) => {
    if (waiter.headersSent) {
      waiter.destroy(error);
      return;
    }
    sendProxyBufferedResponse(waiter, 502, headers, body);
  });
  return true;
}

function proxyToBackend(req, res, url) {
  const normalizedMethod = String(req.method ?? "GET").toUpperCase();
  const normalizedRoute = resolveNormalizedBackendProxyRoute(normalizedMethod, url.pathname);
  const retryableSessionStatus = isRetryableSessionStatusRequest(
    normalizedMethod,
    normalizedRoute,
  );
  const retryBodyPromise = retryableSessionStatus
    ? captureProxyRequestBodyForRetry(req)
    : null;
  const target = resolveBackendProxyTarget(req.method, url.pathname);
  const hotCacheTtlMs = resolveProxyHotGetCacheTtlMs(req.method, url.pathname);
  const hotCacheKey =
    hotCacheTtlMs > 0 ? `${target.role}:${url.pathname}${normalizeProxyCacheSearch(url.search)}` : "";
  const rawInflightKey = resolveProxyInflightGetKey(req.method, url.pathname, url.search);
  const inflightKey = rawInflightKey ? `${target.role}:${rawInflightKey}` : "";
  if (hotCacheKey) {
    const cached = proxyHotGetCache.get(hotCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      sendCachedProxyResponse(res, cached);
      return;
    }
    if (cached) {
      proxyHotGetCache.delete(hotCacheKey);
    }
  }
  if (inflightKey) {
    const inflight = proxyInflightGetRequests.get(inflightKey);
    if (inflight) {
      req.resume();
      if (inflight.waiters.length >= PROXY_INFLIGHT_GET_MAX_WAITERS) {
        const body = Buffer.from(
          JSON.stringify({ ok: false, error: "Troppe richieste coalescenti in attesa." }),
        );
        sendProxyBufferedResponse(
          res,
          503,
          securityHeaders({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(body.length),
            "Retry-After": "1",
            "X-Proxy-In-Flight": "overflow",
            ...proxyTargetResponseHeaders(target),
          }),
          body,
        );
        return;
      }
      inflight.waiters.push(res);
      return;
    }
    proxyInflightGetRequests.set(inflightKey, { waiters: [res], startedAt: Date.now() });
  }
  const forwardedFor = [req.headers["x-forwarded-for"], req.socket.remoteAddress]
    .flat()
    .filter(Boolean)
    .join(", ");
  let activeUpstream = null;
  const startUpstream = (activeTarget, retryCount = 0, retryBody = null) => {
    const attemptStartedAt = Date.now();
    const targetUrl = new URL(`${url.pathname}${url.search}`, activeTarget.url);
    const headers = copyProxyHeaders(req.headers, {
      host: activeTarget.url.host,
      "x-forwarded-for": forwardedFor,
      "x-forwarded-host": req.headers.host ?? "",
      "x-forwarded-proto": req.socket.encrypted ? "https" : "http",
      "x-cassav5bt-proxy-backend-role": activeTarget.role,
      "x-cassav5bt-proxy-backend-desired-role": activeTarget.desiredRole,
    });
    let receivedUpstreamHeaders = false;
    let receivedUpstreamBody = false;
    let attemptSettled = false;
    const settleAttempt = () => {
      if (attemptSettled) return false;
      attemptSettled = true;
      return true;
    };
    const sendBackendUnavailable = (error) => {
      if (inflightKey && sendInflightProxyError(inflightKey, error, activeTarget)) {
        return;
      }
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const body = Buffer.from(JSON.stringify({ ok: false, error: "Backend non raggiungibile." }));
      res.writeHead(
        502,
        securityHeaders({
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(body.length),
          ...proxyTargetResponseHeaders(activeTarget),
        }),
      );
      res.end(body);
    };
    const failAttempt = (error) => {
      if (!settleAttempt()) return;
      reportProxyUpstreamError({
        method: normalizedMethod,
        route: normalizedRoute,
        targetRole: activeTarget.role,
        error,
        elapsedMs: Date.now() - attemptStartedAt,
        phase: receivedUpstreamBody
          ? "after_upstream_body"
          : receivedUpstreamHeaders
            ? "after_upstream_headers"
            : "before_upstream_headers",
      });
      sendBackendUnavailable(error);
    };
    const upstream = activeTarget.request(
      targetUrl,
      {
        method: req.method,
        headers,
        agent: activeTarget.agent,
      },
      (upstreamRes) => {
        if (attemptSettled) {
          upstreamRes.destroy();
          return;
        }
        receivedUpstreamHeaders = true;
        const incompleteResponseError = () => {
          const error = new Error("Backend response interrotta prima del completamento.");
          error.code = "ECONNRESET";
          return error;
        };
        upstreamRes.once("aborted", () => failAttempt(incompleteResponseError()));
        upstreamRes.once("error", (error) => failAttempt(error));
        upstreamRes.once("close", () => {
          if (!upstreamRes.complete) failAttempt(incompleteResponseError());
        });
        upstreamRes.on("data", () => {
          receivedUpstreamBody = true;
        });

        const responseContentType = String(
          upstreamRes.headers["content-type"] ?? "",
        ).toLowerCase();
        const isEventStream =
          isRealtimeEventStreamPath(url.pathname) ||
          responseContentType.includes("text/event-stream");
        const responseHeaders = securityHeaders({
          ...copyProxyHeaders(upstreamRes.headers),
          ...proxyTargetResponseHeaders(activeTarget),
          ...(isEventStream
            ? {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
              }
            : {}),
        });
        if (!hotCacheKey && !inflightKey) {
          if (isEventStream) {
            res.socket?.setNoDelay?.(true);
            res.socket?.setKeepAlive?.(true);
            upstreamRes.socket?.setNoDelay?.(true);
            upstreamRes.socket?.setKeepAlive?.(true);
            res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
            res.flushHeaders?.();
            upstreamRes.on("data", (chunk) => {
              if (!res.write(chunk)) upstreamRes.pause();
              res.flush?.();
            });
            res.on("drain", () => upstreamRes.resume());
            upstreamRes.once("end", () => {
              if (!settleAttempt()) return;
              res.end();
            });
            return;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.once("end", settleAttempt);
          upstreamRes.pipe(res);
          return;
        }
        const chunks = [];
        let size = 0;
        upstreamRes.on("data", (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
        });
        upstreamRes.once("end", () => {
          if (!settleAttempt()) return;
          const body = Buffer.concat(chunks, size);
          const statusCode = upstreamRes.statusCode ?? 502;
          if (hotCacheKey && statusCode === 200 && size <= PROXY_HOT_GET_CACHE_MAX_BYTES) {
            proxyHotGetCache.set(hotCacheKey, {
              statusCode,
              headers: responseHeaders,
              body,
              expiresAt: Date.now() + hotCacheTtlMs,
            });
            pruneProxyHotGetCache();
          }
          if (inflightKey) {
            sendInflightProxyResponse(inflightKey, statusCode, responseHeaders, body, {
              ...(hotCacheKey ? { "X-Proxy-Hot-Cache": "miss" } : {}),
              "X-Proxy-In-Flight": "served",
            });
            return;
          }
          sendProxyBufferedResponse(res, statusCode, responseHeaders, body, {
            "X-Proxy-Hot-Cache": "miss",
          });
        });
      },
    );
    activeUpstream = upstream;

    if (isRealtimeEventStreamPath(url.pathname)) {
      upstream.setTimeout(0);
      upstream.on("socket", (socket) => {
        socket.setNoDelay?.(true);
        socket.setKeepAlive?.(true);
      });
    }

    upstream.once("error", (error) => {
      if (!settleAttempt()) return;
      reportProxyUpstreamError({
        method: normalizedMethod,
        route: normalizedRoute,
        targetRole: activeTarget.role,
        error,
        elapsedMs: Date.now() - attemptStartedAt,
        phase: receivedUpstreamBody
          ? "after_upstream_body"
          : receivedUpstreamHeaders
            ? "after_upstream_headers"
            : "before_upstream_headers",
      });
      const canRetryCoalescedGet =
        retryCount === 0 &&
        normalizedMethod === "GET" &&
        Boolean(inflightKey) &&
        !isRealtimeEventStreamPath(url.pathname) &&
        !receivedUpstreamHeaders &&
        proxyInflightGetRequests.has(inflightKey);
      const canRetrySessionStatus =
        retryCount === 0 &&
        retryableSessionStatus &&
        !receivedUpstreamHeaders &&
        !res.headersSent &&
        !res.writableEnded &&
        !res.destroyed &&
        !req.aborted;
      if (canRetryCoalescedGet) {
        startUpstream(resolveBackendProxyRetryTarget(activeTarget), retryCount + 1);
        return;
      }
      if (canRetrySessionStatus) {
        void retryBodyPromise.then((body) => {
          if (
            body === null ||
            res.headersSent ||
            res.writableEnded ||
            res.destroyed ||
            req.aborted
          ) {
            sendBackendUnavailable(error);
            return;
          }
          activeUpstream = startUpstream(
            resolveBackendProxyRetryTarget(activeTarget),
            retryCount + 1,
            body,
          );
        });
        return;
      }
      sendBackendUnavailable(error);
    });

    if (retryCount === 0) req.pipe(upstream);
    else if (Buffer.isBuffer(retryBody)) upstream.end(retryBody);
    else upstream.end();
    return upstream;
  };

  activeUpstream = startUpstream(target);

  // Un GET coalescente puo avere piu client in attesa dello stesso upstream.
  // L'annullamento di un singolo waiter non deve interrompere gli altri.
  if (!inflightKey) {
    req.on("aborted", () => activeUpstream?.destroy());
    res.on("close", () => {
      if (!res.writableEnded) activeUpstream?.destroy();
    });
  }
}

function proxyToBattery(req, res, url) {
  const targetUrl = new URL(`${url.pathname}${url.search}`, BATTERY_URL);
  const forwardedFor = [req.headers["x-forwarded-for"], req.socket.remoteAddress]
    .flat()
    .filter(Boolean)
    .join(", ");
  const headers = copyProxyHeaders(req.headers, {
    host: BATTERY_URL.host,
    "x-forwarded-for": forwardedFor,
    "x-forwarded-host": req.headers.host ?? "",
    "x-forwarded-proto": req.socket.encrypted ? "https" : "http",
  });

  const upstream = batteryProxyRequest(
    targetUrl,
    {
      method: req.method,
      headers,
      agent: batteryProxyAgent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, securityHeaders(copyProxyHeaders(upstreamRes.headers)));
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify({ ok: false, error: "Battery service non raggiungibile." }));
  });

  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) {
      upstream.destroy();
    }
  });

  req.pipe(upstream);
}

function writeSocketResponse(socket, statusCode, statusMessage, headers = {}) {
  if (socket.destroyed) return;
  const headerLines = Object.entries(headers)
    .filter(([, value]) => value != null)
    .flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((entry) => `${key}: ${entry}`)
        : [`${key}: ${value}`],
    );
  socket.end(
    [
      `HTTP/1.1 ${statusCode} ${statusMessage}`,
      ...headerLines,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );
}

function writeUpgradeResponse(socket, upstreamRes) {
  const statusCode = upstreamRes.statusCode ?? 101;
  const statusMessage = upstreamRes.statusMessage ?? "Switching Protocols";
  const headerLines = Object.entries(upstreamRes.headers)
    .filter(([, value]) => value != null)
    .flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((entry) => `${key}: ${entry}`)
        : [`${key}: ${value}`],
    );
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusMessage}`,
      ...headerLines,
      "",
      "",
    ].join("\r\n"),
  );
}

function proxyUpgradeToBackend(req, socket, head, url) {
  attachSocketErrorGuard(socket);
  const targetUrl = new URL(`${url.pathname}${url.search}`, BACKEND_URL);
  const forwardedFor = [req.headers["x-forwarded-for"], req.socket.remoteAddress]
    .flat()
    .filter(Boolean)
    .join(", ");
  const headers = copyProxyHeaders(req.headers, {
    host: BACKEND_URL.host,
    connection: "Upgrade",
    upgrade: req.headers.upgrade ?? "websocket",
    "x-forwarded-for": forwardedFor,
    "x-forwarded-host": req.headers.host ?? "",
    "x-forwarded-proto": req.socket.encrypted ? "https" : "http",
  });

  const upstream = proxyRequest(targetUrl, {
    method: req.method,
    headers,
    agent: proxyAgent,
  });

  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    attachSocketErrorGuard(upstreamSocket);
    writeUpgradeResponse(socket, upstreamRes);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstream.on("response", (upstreamRes) => {
    writeSocketResponse(socket, upstreamRes.statusCode ?? 502, upstreamRes.statusMessage ?? "Bad Gateway", {
      "Content-Type": upstreamRes.headers["content-type"] ?? "text/plain; charset=utf-8",
    });
    upstreamRes.resume();
  });

  upstream.on("error", () => {
    writeSocketResponse(socket, 502, "Bad Gateway", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.end();
}

async function resolveFile(rootDir, pathname, prefix) {
  const relativeRaw = pathname === prefix ? "/" : pathname.slice(prefix.length) || "/";
  const relativePath = relativeRaw.replace(/^\/+/, "");
  const candidate = path.resolve(rootDir, relativePath || "index.html");
  if (!isInside(rootDir, candidate)) return null;

  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      const indexPath = path.join(candidate, "index.html");
      await fs.access(indexPath);
      return indexPath;
    }
    return candidate;
  } catch {
    const fallback = path.join(rootDir, "index.html");
    try {
      await fs.access(fallback);
      return fallback;
    } catch {
      return null;
    }
  }
}

const handleRequest = async (req, res) => {
  attachRequestErrorGuards(req, res);

  if (isUnsafePathname(req.url ?? "")) {
    res.writeHead(400, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Bad Request");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = sanitizePathname(url.pathname);

  if (isUnsafePathname(pathname)) {
    res.writeHead(400, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Bad Request");
    return;
  }

  if (isBatteryApiPath(pathname)) {
    proxyToBattery(req, res, url);
    return;
  }

  if (isApiPath(pathname)) {
    proxyToBackend(req, res, url);
    return;
  }

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Method Not Allowed");
    return;
  }

  if (pathname === "/") {
    res.writeHead(302, securityHeaders({ Location: "/mobile/" }));
    res.end();
    return;
  }

  const exactApp = APPS.find((entry) => pathname === entry.prefix);
  if (exactApp) {
    res.writeHead(302, securityHeaders({ Location: `${exactApp.prefix}/${url.search}` }));
    res.end();
    return;
  }

  const rootAssetPath = await resolveRootAsset(pathname);
  if (rootAssetPath) {
    const headers = securityHeaders({
      "Content-Type": getContentType(rootAssetPath),
      "Cache-Control": "public, max-age=300",
    });

    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(rootAssetPath).pipe(res);
    return;
  }

  const projectImagePath = await resolveStaticFile(PROJECT_IMG_DIR, pathname, "/img");
  if (projectImagePath) {
    const headers = securityHeaders({
      "Content-Type": getContentType(projectImagePath),
      "Cache-Control": "public, max-age=300",
    });

    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(projectImagePath).pipe(res);
    return;
  }

  const app = resolveApp(pathname);
  if (!app) {
    res.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Not Found");
    return;
  }

  const filePath = await resolveFile(app.dir, pathname, app.prefix);
  if (!filePath) {
    res.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Not Found");
    return;
  }

  const headers = securityHeaders({
    "Content-Type": getContentType(filePath),
    "Cache-Control": app.prefix === "/impostazioni" || filePath.endsWith(".html") ? "no-store" : "public, max-age=300",
  });

  res.writeHead(200, headers);
  if (method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(filePath).pipe(res);
};

const frontendHttpsOptions = getFrontendHttpsOptions();
const frontendProtocol = frontendHttpsOptions ? "https" : "http";
const server = frontendHttpsOptions
  ? createHttpsServer(frontendHttpsOptions, handleRequest)
  : createHttpServer(handleRequest);

server.on("upgrade", (req, socket, head) => {
  if (isUnsafePathname(req.url ?? "")) {
    writeSocketResponse(socket, 400, "Bad Request");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = sanitizePathname(url.pathname);
  if (isUnsafePathname(pathname)) {
    writeSocketResponse(socket, 400, "Bad Request");
    return;
  }

  if (!isApiPath(pathname)) {
    writeSocketResponse(socket, 404, "Not Found");
    return;
  }

  proxyUpgradeToBackend(req, socket, head, url);
});

server.listen(PORT, HOST, () => {
  console.log(`[frontends] Static server attivo su ${frontendProtocol}://${HOST}:${PORT}`);
  console.log(`[frontends] URL principali: ${APPS.map((app) => `${app.prefix}/`).join(" | ")}`);
  console.log(`[frontends] Proxy API verso ${BACKEND_ORIGIN}`);
  if (BACKEND_REALTIME_ORIGIN) console.log(`[frontends] Proxy realtime SSE verso ${BACKEND_REALTIME_ORIGIN}`);
  console.log(`[frontends] Proxy batteria verso ${BATTERY_ORIGIN}`);
});
