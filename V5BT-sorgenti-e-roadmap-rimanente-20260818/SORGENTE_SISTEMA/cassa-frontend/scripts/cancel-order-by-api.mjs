import { performance } from "node:perf_hooks";

function envString(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

const options = {
  origin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  username: envString("CANARY_USERNAME", "amalia"),
  pin: envString("CANARY_PIN", "182018"),
  deviceUuid: envString("CANCEL_DEVICE_UUID", `cancel-order-${Date.now()}`),
  orderId: envString("CANCEL_ORDER_ID"),
  tableId: envString("CANCEL_TABLE_ID"),
  roomId: envString("CANCEL_ROOM_ID"),
  expectedRevision: Number.parseInt(envString("CANCEL_EXPECTED_REVISION", "1"), 10) || 1,
  reason: envString("CANCEL_REASON", "Pulizia canary"),
  idempotencyKey: envString("CANCEL_IDEMPOTENCY_KEY", `cancel-order-${Date.now()}`),
  timeoutMs: Number.parseInt(envString("CANCEL_TIMEOUT_MS", "30000"), 10) || 30_000,
};

if (String(process.env.CANARY_INSECURE_TLS ?? "1") !== "0") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function required(name, value) {
  if (!value) throw new Error(`${name} obbligatorio`);
}

required("CANCEL_ORDER_ID", options.orderId);
required("CANCEL_TABLE_ID", options.tableId);
required("CANCEL_ROOM_ID", options.roomId);

async function requestJson(pathname, init = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${options.timeoutMs}ms`)), options.timeoutMs);
  const requestBody =
    init.body === undefined || typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  try {
    const response = await fetch(`${options.origin}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
      body: requestBody,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { parseError: true, text: text.slice(0, 500) };
    }
    return {
      pathname,
      status: response.status,
      ok: response.ok,
      proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user?.id ?? "",
    "X-Device-Uuid": options.deviceUuid,
    "Content-Type": "application/json",
  };
}

function authPayload(session, extra = {}) {
  return {
    token: session.token,
    userId: session.user?.id,
    username: session.user?.username,
    fullName: session.user?.fullName,
    deviceUuid: options.deviceUuid,
    ...extra,
  };
}

function printStep(label, result) {
  console.log(
    `[cancel-order] ${label} status=${result.status} role=${result.proxyRole || "n.d."} ms=${result.durationMs} code=${result.body?.code ?? ""} error=${result.body?.error ?? ""}`,
  );
}

async function main() {
  const login = await requestJson("/api/auth/login", {
    method: "POST",
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid: options.deviceUuid,
      clientApp: "mobile-frontend",
    },
  });
  printStep("login", login);
  if (login.status !== 200 || !login.body?.token) throw new Error("login fallito");
  const session = login.body;
  const headers = authHeaders(session);
  const basePayload = authPayload(session, {
    tableId: options.tableId,
    roomId: options.roomId,
  });

  const lock = await requestJson("/api/tables/lock/acquire", {
    method: "POST",
    headers,
    body: {
      ...basePayload,
      purpose: "canary.cleanup",
    },
  });
  printStep("lock", lock);
  if (lock.status !== 200 && lock.status !== 409) throw new Error("lock cleanup fallito");

  try {
    const cancel = await requestJson("/api/integration/orders/cancel", {
      method: "POST",
      headers,
      body: {
        ...basePayload,
        orderId: options.orderId,
        expectedRevision: options.expectedRevision,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
      },
    });
    printStep("cancel", cancel);
    if (cancel.status !== 200) throw new Error("cancel fallito");
  } finally {
    const release = await requestJson("/api/tables/lock/release", {
      method: "POST",
      headers,
      body: basePayload,
    });
    printStep("release", release);
  }
}

main().catch((error) => {
  console.error("[cancel-order] errore", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
