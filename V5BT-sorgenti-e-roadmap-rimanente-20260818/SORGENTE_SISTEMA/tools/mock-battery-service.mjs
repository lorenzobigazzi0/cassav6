import { createServer } from "node:http";

const host = String(process.env.MOCK_BATTERY_HOST || "127.0.0.1").trim();
const port = Number(process.env.MOCK_BATTERY_PORT || 9790);
const deviceCount = Math.max(1, Math.min(500, Number(process.env.MOCK_BATTERY_DEVICES || 20)));
const changeIntervalMs = Math.max(1_000, Number(process.env.MOCK_BATTERY_CHANGE_INTERVAL_MS || 120_000));
const devices = Array.from({ length: deviceCount }, (_, index) => ({
  device_id: `load-device-${index + 1}`,
  device: `Palmare Load ${index + 1}`,
  battery_level: 92 - (index % 17),
  charging: index % 5 === 0,
  online: true,
  last_update: new Date().toISOString(),
  age_seconds: 0,
  received_count: 1,
}));
const clients = new Set();
let sequence = 0;

function snapshot() {
  return {
    ok: true,
    sequence,
    notificationIntervalMs: changeIntervalMs,
    devices: devices.map((device) => ({ ...device })),
  };
}

function writeEvent(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && ["/", "/health"].includes(url.pathname)) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      ok: true,
      service: "mock-battery",
      devices: deviceCount,
      notificationIntervalMs: changeIntervalMs,
    }));
    return;
  }
  if (request.method === "GET" && ["/battery", "/api/battery"].includes(url.pathname)) {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(snapshot()));
    return;
  }
  if (request.method === "GET" && ["/battery/events", "/api/battery/events"].includes(url.pathname)) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
    });
    clients.add(response);
    writeEvent(response, "ready", { ok: true, sequence });
    writeEvent(response, "battery", snapshot());
    request.on("close", () => clients.delete(response));
    return;
  }
  response.writeHead(404).end();
});

const updateTimer = setInterval(() => {
  sequence += 1;
  const index = sequence % devices.length;
  const device = devices[index];
  device.battery_level = Math.max(5, device.battery_level - 1);
  if (sequence % 7 === 0) device.charging = !device.charging;
  device.last_update = new Date().toISOString();
  device.received_count += 1;
  const payload = snapshot();
  for (const client of clients) writeEvent(client, "battery", payload);
}, changeIntervalMs);
updateTimer.unref();

server.listen(port, host, () => {
  console.log(`[mock-battery] http://${host}:${port}/battery devices=${deviceCount}`);
});

function shutdown() {
  clearInterval(updateTimer);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
