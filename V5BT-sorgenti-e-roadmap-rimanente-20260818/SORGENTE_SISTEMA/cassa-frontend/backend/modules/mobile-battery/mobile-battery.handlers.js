function normalizeIdentifier(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeLooseIdentifier(value) {
  return normalizeIdentifier(value).replace(/[^a-z0-9]/g, "");
}

function normalizeIp(value) {
  const firstValue = String(value ?? "").split(",")[0]?.trim() ?? "";
  return firstValue.replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "").trim().toLowerCase();
}

function parseBatteryBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "si", "sì", "charging", "online"].includes(normalized)) return true;
    if (["0", "false", "no", "offline", "not_charging", "non in carica"].includes(normalized)) return false;
  }
  return fallback;
}

function readBatteryLevel(device = {}) {
  const rawLevel =
    device.level ??
    device.battery_level ??
    device.batteryLevel ??
    device.percent ??
    device.percentage ??
    device.batteryPercent;
  const parsed = Number(rawLevel);
  if (!Number.isFinite(parsed)) return null;
  const normalized = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, normalized));
}

function readDeviceIdentifier(device = {}) {
  return (
    device.device_id ||
    device.deviceId ||
    device.device_uuid ||
    device.deviceUuid ||
    device.uuid ||
    device.id ||
    ""
  );
}

function normalizeBatteryDevice(device = {}) {
  const level = readBatteryLevel(device);
  const charging = parseBatteryBoolean(device.charging, false);
  const online = parseBatteryBoolean(device.online, true);

  return {
    deviceId: String(readDeviceIdentifier(device) || ""),
    deviceName: String(device.device || device.name || device.deviceName || ""),
    level,
    charging,
    online,
    low: typeof level === "number" ? level < 20 : false,
    clientIp: device.client_ip || device.clientIp || device.ip || null,
    lastUpdate: device.last_update || device.lastUpdate || device.updatedAt || null,
    ageSeconds: Number.isFinite(Number(device.age_seconds ?? device.ageSeconds)) ? Number(device.age_seconds ?? device.ageSeconds) : null,
    receivedCount: Number.isFinite(Number(device.received_count ?? device.receivedCount)) ? Number(device.received_count ?? device.receivedCount) : null,
  };
}

function compareBatteryDevices(left, right) {
  const leftOnline = left?.online === true ? 1 : 0;
  const rightOnline = right?.online === true ? 1 : 0;
  if (leftOnline !== rightOnline) return rightOnline - leftOnline;
  const leftName = String(left?.deviceName || left?.deviceId || "").trim();
  const rightName = String(right?.deviceName || right?.deviceId || "").trim();
  return leftName.localeCompare(rightName, "it-IT", { sensitivity: "base" });
}

function buildBatteryStateSignature(device, stale = false) {
  if (!device || typeof device.level !== "number") return `unknown|${stale ? "stale" : "fresh"}`;
  return [
    Math.max(0, Math.min(100, Math.round(device.level))),
    device.charging ? "charging" : "not-charging",
    device.online === false ? "offline" : "online",
    normalizeIdentifier(device.deviceName),
    stale ? "stale" : "fresh",
  ].join("|");
}

function writeSseEvent(res, eventName, payload = undefined) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const lines = [];
  if (eventName) lines.push(`event: ${eventName}`);
  if (payload !== undefined) {
    const serialized = JSON.stringify(payload);
    serialized.split(/\r?\n/).forEach((line) => {
      lines.push(`data: ${line}`);
    });
  }
  lines.push("");

  try {
    res.write(`${lines.join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

function normalizePositiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildBatteryEventsUrl(serviceUrl) {
  try {
    const url = new URL(serviceUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (/\/api\/battery$/i.test(normalizedPath)) {
      url.pathname = normalizedPath.replace(/\/api\/battery$/i, "/api/battery/events");
      return url.toString();
    }
    if (/\/battery$/i.test(normalizedPath)) {
      url.pathname = normalizedPath.replace(/\/battery$/i, "/battery/events");
      return url.toString();
    }
    url.pathname = `${normalizedPath}/battery/events`.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return "";
  }
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let eventName = "message";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventName = value || "message";
    if (field === "data") dataLines.push(value);
  }
  return {
    eventName,
    data: dataLines.join("\n"),
  };
}

function readDeviceAliases(device = {}) {
  return [
    readDeviceIdentifier(device),
    device.device,
    device.name,
    device.deviceName,
    device.hostname,
    device.label,
    device.model,
    device.android_id,
    device.androidId,
    device.serial,
    device.client_ip,
    device.clientIp,
    device.ip,
  ]
    .map(normalizeIdentifier)
    .filter(Boolean);
}

function extractBatteryDevices(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (!snapshot || typeof snapshot !== "object") return [];
  const candidates = [
    snapshot.devices,
    snapshot.data?.devices,
    snapshot.items,
    snapshot.results,
    snapshot.deviceList,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  const values = Object.values(snapshot);
  if (
    values.length > 0 &&
    values.every((entry) => entry && typeof entry === "object") &&
    values.some((entry) => readBatteryLevel(entry) !== null)
  ) {
    return values;
  }
  return [];
}

function pickBestDeviceMatch(matches = []) {
  const validMatches = matches.filter((device) => device && typeof device === "object");
  if (validMatches.length === 0) return null;
  return [...validMatches].sort((a, b) => {
    const aOnline = parseBatteryBoolean(a.online, true) ? 1 : 0;
    const bOnline = parseBatteryBoolean(b.online, true) ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    const aAge = Number(a.age_seconds ?? a.ageSeconds);
    const bAge = Number(b.age_seconds ?? b.ageSeconds);
    const aAgeSafe = Number.isFinite(aAge) ? aAge : Number.POSITIVE_INFINITY;
    const bAgeSafe = Number.isFinite(bAge) ? bAge : Number.POSITIVE_INFINITY;
    if (aAgeSafe !== bAgeSafe) return aAgeSafe - bAgeSafe;
    const aTime = Date.parse(a.last_update || a.lastUpdate || a.updatedAt || 0) || 0;
    const bTime = Date.parse(b.last_update || b.lastUpdate || b.updatedAt || 0) || 0;
    return bTime - aTime;
  })[0];
}

function findDeviceForRequest(devices, requestedDeviceUuid, requestedClientIp = "") {
  const wanted = normalizeIdentifier(requestedDeviceUuid);
  if (wanted) {
    const wantedLoose = normalizeLooseIdentifier(wanted);
    for (const device of devices) {
      const aliases = readDeviceAliases(device);
      if (aliases.includes(wanted) || (wantedLoose && aliases.some((alias) => normalizeLooseIdentifier(alias) === wantedLoose))) {
        return { device: normalizeBatteryDevice(device), matchedBy: "device_id" };
      }
    }

    const wantedDeviceIp = normalizeIp(requestedDeviceUuid);
    const identifierIpMatches = devices.filter((device) => normalizeIp(device.client_ip || device.clientIp || device.ip) === wantedDeviceIp);
    const identifierIpMatch = pickBestDeviceMatch(identifierIpMatches);
    if (identifierIpMatch) {
      return { device: normalizeBatteryDevice(identifierIpMatch), matchedBy: "device_ip" };
    }
  }

  const wantedIp = normalizeIp(requestedClientIp);
  if (wantedIp) {
    const ipMatches = devices.filter((device) => normalizeIp(device.client_ip || device.clientIp || device.ip) === wantedIp);
    const ipMatch = pickBestDeviceMatch(ipMatches);
    if (ipMatch) {
      return { device: normalizeBatteryDevice(ipMatch), matchedBy: "client_ip" };
    }
  }

  return { device: null, matchedBy: "" };
}

export function createMobileBatteryHandlers({
  batteryServiceUrl,
  cacheMs = 5000,
  eventPollMs = 15000,
  fetchWithTimeout,
  sendJson,
  timeoutMs = 2500,
}) {
  let cachedSnapshot = null;
  let cachedAtMs = 0;
  const eventPollMsResolved = normalizePositiveMs(eventPollMs, 15000);
  const batteryEventsUrl = buildBatteryEventsUrl(batteryServiceUrl);
  const eventClients = new Map();
  let eventClientSequence = 1;
  let upstreamAbortController = null;
  let upstreamConnecting = false;
  let upstreamReconnectTimer = null;
  let sharedFallbackTimer = null;

  async function fetchBatterySnapshot({ force = false } = {}) {
    const nowMs = Date.now();
    if (!force && cachedSnapshot && nowMs - cachedAtMs < cacheMs) {
      return { snapshot: cachedSnapshot, stale: false };
    }

    try {
      const response = await fetchWithTimeout(batteryServiceUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs,
      });
      if (!response.ok) {
        throw new Error(`Battery service responded with ${response.status}`);
      }
      const snapshot = await response.json();
      cachedSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
      cachedAtMs = nowMs;
      return { snapshot: cachedSnapshot, stale: false };
    } catch (error) {
      if (cachedSnapshot) {
        return { snapshot: cachedSnapshot, stale: true, error: error.message };
      }
      throw error;
    }
  }

  function updateCachedSnapshotDevice(device) {
    if (!device || typeof device !== "object") return;
    const nowMs = Date.now();
    const devices = extractBatteryDevices(cachedSnapshot);
    const incomingDevice = normalizeBatteryDevice(device);
    const incomingId = normalizeIdentifier(incomingDevice.deviceId);
    const incomingIp = normalizeIp(incomingDevice.clientIp);
    const incomingName = normalizeIdentifier(incomingDevice.deviceName);
    let replaced = false;
    const nextDevices = devices.map((entry) => {
      const currentDevice = normalizeBatteryDevice(entry);
      const sameId = incomingId && normalizeIdentifier(currentDevice.deviceId) === incomingId;
      const sameIp = !incomingId && incomingIp && normalizeIp(currentDevice.clientIp) === incomingIp;
      const sameName = !incomingId && !incomingIp && incomingName && normalizeIdentifier(currentDevice.deviceName) === incomingName;
      if (sameId || sameIp || sameName) {
        replaced = true;
        return device;
      }
      return entry;
    });
    if (!replaced) nextDevices.push(device);
    const normalizedDevices = nextDevices.map((entry) => normalizeBatteryDevice(entry));
    cachedSnapshot = {
      ...(cachedSnapshot && typeof cachedSnapshot === "object" ? cachedSnapshot : {}),
      devices: nextDevices,
      device_count: nextDevices.length,
      online_count: normalizedDevices.filter((entry) => entry.online).length,
      offline_count: normalizedDevices.filter((entry) => !entry.online).length,
      charging_count: normalizedDevices.filter((entry) => entry.charging).length,
      average_level: (() => {
        const levels = normalizedDevices
          .map((entry) => entry.level)
          .filter((level) => typeof level === "number");
        return levels.length ? Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length) : null;
      })(),
    };
    cachedAtMs = nowMs;
  }

  function buildBatteryPayload({ snapshot, stale, error, requestedDeviceUuid, requestedClientIp }) {
    const devices = extractBatteryDevices(snapshot);
    const match = findDeviceForRequest(devices, requestedDeviceUuid, requestedClientIp);
    const device = match.device;

    return {
      ok: true,
      stale: Boolean(stale),
      error: error || null,
      endpoint: batteryServiceUrl,
      requestedDeviceUuid: requestedDeviceUuid || null,
      requestedClientIp: normalizeIp(requestedClientIp) || null,
      matched: Boolean(device),
      matchedBy: match.matchedBy || null,
      device,
      deviceCount: Number.isFinite(Number(snapshot.device_count)) ? Number(snapshot.device_count) : devices.length,
      onlineCount: Number.isFinite(Number(snapshot.online_count)) ? Number(snapshot.online_count) : null,
      offlineCount: Number.isFinite(Number(snapshot.offline_count)) ? Number(snapshot.offline_count) : null,
      chargingCount: Number.isFinite(Number(snapshot.charging_count)) ? Number(snapshot.charging_count) : null,
      averageLevel: Number.isFinite(Number(snapshot.average_level)) ? Number(snapshot.average_level) : null,
      fetchedAt: new Date(cachedAtMs || Date.now()).toISOString(),
    };
  }

  function buildBatteryPayloadFromDevice({ device, stale = false, error = null, requestedDeviceUuid, requestedClientIp }) {
    const match = findDeviceForRequest([device], requestedDeviceUuid, requestedClientIp);
    const normalizedDevice = match.device;
    return {
      ok: true,
      stale: Boolean(stale),
      error: error || null,
      endpoint: batteryServiceUrl,
      requestedDeviceUuid: requestedDeviceUuid || null,
      requestedClientIp: normalizeIp(requestedClientIp) || null,
      matched: Boolean(normalizedDevice),
      matchedBy: match.matchedBy || null,
      device: normalizedDevice,
      deviceCount: cachedSnapshot && typeof cachedSnapshot === "object" && Number.isFinite(Number(cachedSnapshot.device_count))
        ? Number(cachedSnapshot.device_count)
        : null,
      onlineCount: cachedSnapshot && typeof cachedSnapshot === "object" && Number.isFinite(Number(cachedSnapshot.online_count))
        ? Number(cachedSnapshot.online_count)
        : null,
      offlineCount: cachedSnapshot && typeof cachedSnapshot === "object" && Number.isFinite(Number(cachedSnapshot.offline_count))
        ? Number(cachedSnapshot.offline_count)
        : null,
      chargingCount: cachedSnapshot && typeof cachedSnapshot === "object" && Number.isFinite(Number(cachedSnapshot.charging_count))
        ? Number(cachedSnapshot.charging_count)
        : null,
      averageLevel: cachedSnapshot && typeof cachedSnapshot === "object" && Number.isFinite(Number(cachedSnapshot.average_level))
        ? Number(cachedSnapshot.average_level)
        : null,
      fetchedAt: new Date(cachedAtMs || Date.now()).toISOString(),
    };
  }

  function sendBatteryPayloadToClient(client, payload, { force = false } = {}) {
    if (!client || client.disposed) return false;
    const signature = buildBatteryStateSignature(payload.device, payload.stale);
    if (!force && signature === client.lastSignature) return true;
    client.lastSignature = signature;
    return writeSseEvent(client.res, "battery", payload);
  }

  async function sendBatteryStateToClient(client, { force = false } = {}) {
    if (!client || client.disposed || client.inflight) return;
    client.inflight = true;
    try {
      const { snapshot, stale, error } = await fetchBatterySnapshot({ force });
      if (client.disposed) return;
      const payload = buildBatteryPayload({
        snapshot,
        stale,
        error,
        requestedDeviceUuid: client.requestedDeviceUuid,
        requestedClientIp: client.requestedClientIp,
      });
      if (!sendBatteryPayloadToClient(client, payload, { force })) {
        removeBatteryEventClient(client.id);
      }
    } catch (error) {
      if (client.disposed) return;
      const payload = {
        ok: false,
        stale: false,
        error: "Battery service unavailable",
        detail: error.message,
        endpoint: batteryServiceUrl,
        requestedDeviceUuid: client.requestedDeviceUuid || null,
        requestedClientIp: normalizeIp(client.requestedClientIp) || null,
        matched: false,
        device: null,
        deviceCount: 0,
        onlineCount: null,
        offlineCount: null,
        chargingCount: null,
        averageLevel: null,
        fetchedAt: new Date().toISOString(),
      };
      if (!sendBatteryPayloadToClient(client, payload, { force })) {
        removeBatteryEventClient(client.id);
      }
    } finally {
      client.inflight = false;
    }
  }

  async function handleMobileBattery(req, res, requestUrl) {
    const authPayload = req.__authPayload || {};
    const queryDeviceUuid = requestUrl.searchParams.get("deviceUuid");
    const queryMobileDeviceUuid = requestUrl.searchParams.get("mobileDeviceUuid");
    const requestedDeviceUuid = queryDeviceUuid || queryMobileDeviceUuid || authPayload.deviceUuid || req.headers["x-device-uuid"] || "";
    const requestedClientIp =
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "";

    try {
      const { snapshot, stale, error } = await fetchBatterySnapshot();
      sendJson(
        res,
        200,
        buildBatteryPayload({ snapshot, stale, error, requestedDeviceUuid, requestedClientIp })
      );
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        stale: false,
        error: "Battery service unavailable",
        detail: error.message,
        endpoint: batteryServiceUrl,
        requestedDeviceUuid: requestedDeviceUuid || null,
        requestedClientIp: normalizeIp(requestedClientIp) || null,
        matched: false,
        device: null,
        deviceCount: 0,
        onlineCount: null,
        offlineCount: null,
        chargingCount: null,
        averageLevel: null,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  async function broadcastBatterySnapshotToClients({ force = false } = {}) {
    if (eventClients.size === 0) return;
    try {
      const { snapshot, stale, error } = await fetchBatterySnapshot({ force });
      for (const client of eventClients.values()) {
        if (client.disposed) continue;
        const payload = buildBatteryPayload({
          snapshot,
          stale,
          error,
          requestedDeviceUuid: client.requestedDeviceUuid,
          requestedClientIp: client.requestedClientIp,
        });
        if (!sendBatteryPayloadToClient(client, payload)) {
          removeBatteryEventClient(client.id);
        }
      }
    } catch (error) {
      for (const client of eventClients.values()) {
        if (client.disposed) continue;
        const payload = {
          ok: false,
          stale: false,
          error: "Battery service unavailable",
          detail: error.message,
          endpoint: batteryServiceUrl,
          requestedDeviceUuid: client.requestedDeviceUuid || null,
          requestedClientIp: normalizeIp(client.requestedClientIp) || null,
          matched: false,
          device: null,
          deviceCount: 0,
          onlineCount: null,
          offlineCount: null,
          chargingCount: null,
          averageLevel: null,
          fetchedAt: new Date().toISOString(),
        };
        if (!sendBatteryPayloadToClient(client, payload)) {
          removeBatteryEventClient(client.id);
        }
      }
    }
  }

  function startSharedFallbackTimer() {
    if (sharedFallbackTimer !== null || eventClients.size === 0) return;
    sharedFallbackTimer = setInterval(() => {
      void broadcastBatterySnapshotToClients({ force: true });
    }, eventPollMsResolved);
  }

  function stopSharedFallbackTimer() {
    if (sharedFallbackTimer === null) return;
    clearInterval(sharedFallbackTimer);
    sharedFallbackTimer = null;
  }

  function scheduleUpstreamReconnect() {
    if (upstreamReconnectTimer !== null || eventClients.size === 0) return;
    upstreamReconnectTimer = setTimeout(() => {
      upstreamReconnectTimer = null;
      ensureBatteryEventStream();
    }, 1500);
  }

  function removeBatteryEventClient(clientId) {
    const client = eventClients.get(clientId);
    if (!client) return;
    client.disposed = true;
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
    eventClients.delete(clientId);
    if (eventClients.size === 0) {
      stopSharedFallbackTimer();
      if (upstreamReconnectTimer !== null) {
        clearTimeout(upstreamReconnectTimer);
        upstreamReconnectTimer = null;
      }
      if (upstreamAbortController) {
        upstreamAbortController.abort();
        upstreamAbortController = null;
      }
    }
  }

  function handleBatteryServiceEvent(payload) {
    const device = payload?.device;
    if (!device || typeof device !== "object") return;
    updateCachedSnapshotDevice(device);
    for (const client of eventClients.values()) {
      if (client.disposed) continue;
      const clientPayload = buildBatteryPayloadFromDevice({
        device,
        stale: false,
        error: null,
        requestedDeviceUuid: client.requestedDeviceUuid,
        requestedClientIp: client.requestedClientIp,
      });
      if (!clientPayload.matched) continue;
      if (!sendBatteryPayloadToClient(client, clientPayload)) {
        removeBatteryEventClient(client.id);
      }
    }
  }

  async function consumeBatteryEventStream(response) {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("Battery event stream not readable");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (!event.data) continue;
        try {
          const payload = JSON.parse(event.data);
          if (event.eventName === "battery" || payload?.type === "battery") {
            handleBatteryServiceEvent(payload);
          }
        } catch {
          // ignore malformed upstream events
        }
      }
    }
  }

  async function runBatteryEventStream(controller) {
    try {
      const response = await fetch(batteryEventsUrl, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Battery event stream responded with ${response.status}`);
      }
      await consumeBatteryEventStream(response);
    } catch (error) {
      if (error?.name !== "AbortError") {
        // The slow shared fallback remains active when the upstream event stream is unavailable.
      }
    } finally {
      if (upstreamAbortController === controller) {
        upstreamAbortController = null;
      }
      upstreamConnecting = false;
      if (eventClients.size > 0) {
        startSharedFallbackTimer();
        scheduleUpstreamReconnect();
      }
    }
  }

  function ensureBatteryEventStream() {
    if (!batteryEventsUrl || typeof fetch !== "function") {
      startSharedFallbackTimer();
      return;
    }
    if (upstreamAbortController || upstreamConnecting || eventClients.size === 0) return;
    upstreamConnecting = true;
    const controller = new AbortController();
    upstreamAbortController = controller;
    startSharedFallbackTimer();
    void runBatteryEventStream(controller);
  }

  function handleMobileBatteryEvents(req, res, requestUrl) {
    const queryDeviceUuid = requestUrl.searchParams.get("deviceUuid");
    const queryMobileDeviceUuid = requestUrl.searchParams.get("mobileDeviceUuid");
    const queryBatteryDevice =
      requestUrl.searchParams.get("batteryDevice") ||
      requestUrl.searchParams.get("batteryDeviceId") ||
      requestUrl.searchParams.get("batteryIp");
    const authPayload = req.__authPayload || {};
    const requestedDeviceUuid =
      queryDeviceUuid ||
      queryBatteryDevice ||
      queryMobileDeviceUuid ||
      authPayload.deviceUuid ||
      req.headers["x-device-uuid"] ||
      "";
    const requestedClientIp =
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "";
    const clientId = `mobile_battery_${eventClientSequence++}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    const client = {
      id: clientId,
      res,
      requestedDeviceUuid,
      requestedClientIp,
      heartbeatTimer: null,
      lastSignature: "",
      disposed: false,
      inflight: false,
    };
    eventClients.set(clientId, client);
    client.heartbeatTimer = setInterval(() => {
      if (!writeSseEvent(res, "", undefined)) {
        removeBatteryEventClient(clientId);
      }
    }, 15000);

    writeSseEvent(res, "ready", {
      ok: true,
      endpoint: batteryServiceUrl,
      eventsEndpoint: batteryEventsUrl || null,
      fallbackPollMs: eventPollMsResolved,
      connectedAt: new Date().toISOString(),
    });
    void sendBatteryStateToClient(client, { force: true });
    ensureBatteryEventStream();

    const cleanup = () => removeBatteryEventClient(clientId);
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  async function handleMobileBatteryDevices(_req, res) {
    try {
      const { snapshot, stale, error } = await fetchBatterySnapshot();
      const devices = extractBatteryDevices(snapshot)
        .map((device) => normalizeBatteryDevice(device))
        .filter((device) => String(device.deviceId || device.deviceName || device.clientIp || "").trim())
        .sort(compareBatteryDevices);

      sendJson(res, 200, {
        ok: true,
        stale: Boolean(stale),
        error: error || null,
        endpoint: batteryServiceUrl,
        devices,
        deviceCount: Number.isFinite(Number(snapshot.device_count)) ? Number(snapshot.device_count) : devices.length,
        onlineCount: Number.isFinite(Number(snapshot.online_count))
          ? Number(snapshot.online_count)
          : devices.filter((device) => device.online).length,
        offlineCount: Number.isFinite(Number(snapshot.offline_count))
          ? Number(snapshot.offline_count)
          : devices.filter((device) => !device.online).length,
        chargingCount: Number.isFinite(Number(snapshot.charging_count))
          ? Number(snapshot.charging_count)
          : devices.filter((device) => device.charging).length,
        averageLevel: Number.isFinite(Number(snapshot.average_level)) ? Number(snapshot.average_level) : null,
        fetchedAt: new Date(cachedAtMs || Date.now()).toISOString(),
      });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        stale: false,
        error: "Battery service unavailable",
        detail: error.message,
        endpoint: batteryServiceUrl,
        devices: [],
        deviceCount: 0,
        onlineCount: 0,
        offlineCount: 0,
        chargingCount: 0,
        averageLevel: null,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  return {
    "mobile.battery": handleMobileBattery,
    "mobile.batteryEvents": handleMobileBatteryEvents,
    "mobile.batteryDevices": handleMobileBatteryDevices,
  };
}
