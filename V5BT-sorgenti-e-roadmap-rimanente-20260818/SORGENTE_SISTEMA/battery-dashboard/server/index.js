import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8765);
const OFFLINE_AFTER_SECONDS = Number(process.env.OFFLINE_AFTER_SECONDS || 180);
const REMOVE_AFTER_SECONDS = Number(process.env.REMOVE_AFTER_SECONDS || 300);
const MAX_LOG_LINES = 160;

const app = express();
const devices = new Map();
const events = [];
const streamClients = new Map();
let streamClientSequence = 1;
let batteryStateVersion = 0;

app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

function now() {
  return new Date();
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(nets)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        candidates.push(item.address);
      }
    }
  }

  return candidates.find((ip) => ip.startsWith("192.168.")) || candidates[0] || "127.0.0.1";
}

function normalizeIp(value) {
  return String(value || "")
    .replace(/^::ffff:/, "")
    .replace(/^::1$/, "127.0.0.1");
}

function normalizeDeviceName(value) {
  return String(value || "").trim().toLowerCase();
}

function shortId(value) {
  const text = String(value || "").trim();
  if (!text) return "N/D";
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function addEvent(message) {
  const line = {
    time: now().toISOString(),
    message
  };
  events.push(line);
  while (events.length > MAX_LOG_LINES) {
    events.shift();
  }
}

function buildDeviceStateSignature(record) {
  if (!record) return "";
  return [
    record.level === null ? "unknown" : Math.round(record.level),
    record.charging ? "charging" : "not-charging",
    record.online === false ? "offline" : "online"
  ].join("|");
}

function writeStreamEvent(client, eventName, payload) {
  if (!client?.res || client.res.writableEnded || client.res.destroyed) return false;

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
    client.res.write(`${lines.join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

function removeStreamClient(clientId) {
  const client = streamClients.get(clientId);
  if (!client) return;
  if (client.heartbeatTimer) {
    clearInterval(client.heartbeatTimer);
  }
  streamClients.delete(clientId);
}

function publishBatteryEvent(record, previousRecord = null) {
  if (streamClients.size === 0) return;
  const payload = {
    type: "battery",
    status: "ok",
    state_version: batteryStateVersion,
    changed_at: now().toISOString(),
    device: serializeDevice(record),
    previous: previousRecord ? serializeDevice(previousRecord) : null
  };

  for (const [clientId, client] of streamClients.entries()) {
    if (!writeStreamEvent(client, "battery", payload)) {
      removeStreamClient(clientId);
    }
  }
}

function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["1", "true", "yes", "si", "charging"].includes(value.trim().toLowerCase());
  }
  return false;
}

function parseBatteryLevel(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, parsed));
}

function isOnline(record, currentTime = now()) {
  if (!record.last_update) return false;
  return (currentTime.getTime() - record.last_update.getTime()) / 1000 <= OFFLINE_AFTER_SECONDS;
}

function cleanupExpiredDevices(currentTime = now()) {
  for (const [deviceId, record] of devices.entries()) {
    if (!record.last_update) continue;

    const ageSeconds = (currentTime.getTime() - record.last_update.getTime()) / 1000;
    if (ageSeconds > REMOVE_AFTER_SECONDS) {
      devices.delete(deviceId);
      addEvent(`${shortId(deviceId)} | rimosso dopo ${Math.round(ageSeconds)}s senza messaggi`);
    }
  }
}

function findMergeCandidateId(deviceId, device, clientIp, currentTime = now()) {
  if (!clientIp) return "";
  const normalizedDevice = normalizeDeviceName(device);
  for (const [candidateId, record] of devices.entries()) {
    if (candidateId === deviceId) continue;
    if (normalizeIp(record.client_ip) !== clientIp) continue;
    if (normalizeDeviceName(record.device) !== normalizedDevice) continue;
    const ageSeconds = record.last_update
      ? (currentTime.getTime() - record.last_update.getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    if (ageSeconds <= REMOVE_AFTER_SECONDS) return candidateId;
  }
  return "";
}

function serializeDevice(record, currentTime = now()) {
  const ageSeconds = record.last_update
    ? Math.max(0, Math.round((currentTime.getTime() - record.last_update.getTime()) / 1000))
    : null;

  return {
    ...record,
    last_update: record.last_update ? record.last_update.toISOString() : null,
    age_seconds: ageSeconds,
    online: isOnline(record, currentTime)
  };
}

function snapshot() {
  const currentTime = now();
  cleanupExpiredDevices(currentTime);

  const list = Array.from(devices.values())
    .map((record) => serializeDevice(record, currentTime))
    .sort((a, b) => new Date(b.last_update || 0) - new Date(a.last_update || 0));

  const onlineCount = list.filter((device) => device.online).length;
  const chargingCount = list.filter((device) => device.charging).length;
  const levels = list.map((device) => device.level).filter((level) => typeof level === "number");
  const averageLevel = levels.length
    ? Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length)
    : null;

  return {
    status: "ok",
    state_version: batteryStateVersion,
    endpoint: `http://${getLocalIp()}:${PORT}/battery`,
    offline_after_seconds: OFFLINE_AFTER_SECONDS,
    remove_after_seconds: REMOVE_AFTER_SECONDS,
    device_count: list.length,
    online_count: onlineCount,
    offline_count: Math.max(0, list.length - onlineCount),
    charging_count: chargingCount,
    average_level: averageLevel,
    devices: list,
    events: events.slice().reverse()
  };
}

app.get(["/health", "/api/health", "/battery", "/api/battery"], (_req, res) => {
  res.json(snapshot());
});

app.get("/api/events", (_req, res) => {
  res.json({ status: "ok", events: events.slice().reverse() });
});

app.get(["/battery/events", "/api/battery/events", "/api/events/stream"], (req, res) => {
  const clientId = `battery_stream_${streamClientSequence++}`;
  const streamClient = {
    id: clientId,
    res,
    heartbeatTimer: null
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  if (res.socket) {
    res.socket.setTimeout(0);
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true);
  }

  streamClients.set(clientId, streamClient);
  streamClient.heartbeatTimer = setInterval(() => {
    if (!writeStreamEvent(streamClient, "", undefined)) {
      removeStreamClient(clientId);
    }
  }, 15000);

  writeStreamEvent(streamClient, "ready", {
    status: "ok",
    state_version: batteryStateVersion,
    connected_at: now().toISOString()
  });

  const cleanup = () => removeStreamClient(clientId);
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
});

app.post("/battery", (req, res) => {
  try {
    const payload = req.body || {};
    const level = parseBatteryLevel(payload.battery_level ?? payload.level);
    const charging = parseBool(payload.charging);
    const device = String(payload.device || "Android").trim() || "Android";
    const rawDeviceId = payload.device_id ?? payload.deviceId ?? payload.deviceUuid ?? "";
    const clientIp = normalizeIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
    const deviceId = String(rawDeviceId || "").trim() || `${clientIp || "unknown"}:${device}`;
    const mergeCandidateId = devices.has(deviceId) ? "" : findMergeCandidateId(deviceId, device, clientIp);
    const previous = devices.get(deviceId) || (mergeCandidateId ? devices.get(mergeCandidateId) : null);
    const receivedCount = (previous?.received_count || 0) + 1;
    const lastUpdate = now();

    const previousSignature = buildDeviceStateSignature(previous);
    const record = {
      device_id: deviceId,
      device,
      level,
      charging,
      client_ip: clientIp || "N/D",
      last_update: lastUpdate,
      received_count: receivedCount,
      state_version: previous?.state_version || 0
    };
    const nextSignature = buildDeviceStateSignature(record);
    const identityChanged = Boolean(previous && previous.device_id !== deviceId);
    const stateChanged = !previous || identityChanged || previousSignature !== nextSignature;
    if (stateChanged) {
      batteryStateVersion += 1;
      record.state_version = batteryStateVersion;
    }

    if (mergeCandidateId) {
      devices.delete(mergeCandidateId);
    }
    devices.set(deviceId, record);
    if (stateChanged) {
      addEvent(
        `${shortId(deviceId)} | ${device} | ${level === null ? "N/D" : `${level}%`} | ${
          charging ? "in carica" : "non in carica"
        }`
      );
      publishBatteryEvent(record, previous || null);
    }

    res.json({ status: "ok", device_id: deviceId, changed: stateChanged, state_version: record.state_version });
  } catch (error) {
    addEvent(`Errore richiesta: ${error.message}`);
    res.status(400).json({ status: "error", error: error.message });
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "..", "dist");

app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"), (error) => {
    if (error) {
      res.status(404).send("Dashboard non buildata. Esegui npm run build.");
    }
  });
});

addEvent(`Server avviato su porta ${PORT}`);
app.listen(PORT, HOST, () => {
  const endpoint = `http://${getLocalIp()}:${PORT}/battery`;
  console.log(`Battery dashboard: http://${getLocalIp()}:${PORT}`);
  console.log(`Android endpoint: ${endpoint}`);
});
