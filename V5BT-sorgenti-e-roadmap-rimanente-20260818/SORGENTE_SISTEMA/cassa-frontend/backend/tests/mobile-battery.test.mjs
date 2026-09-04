import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMobileBatteryHandlers } from "../modules/mobile-battery/index.js";

async function callBatteryHandler(snapshot, options = {}) {
  let captured = null;
  const handlers = createMobileBatteryHandlers({
    batteryServiceUrl: "http://battery.test/battery",
    cacheMs: 0,
    timeoutMs: 100,
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => snapshot,
    }),
    sendJson: (_res, status, body) => {
      captured = { status, body };
    },
  });
  const req = {
    __authPayload: options.authPayload ?? {},
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? "" },
  };
  const url = new URL(`http://app.local/api/mobile/battery${options.search ?? ""}`);
  await handlers["mobile.battery"](req, {}, url);
  assert.ok(captured, "handler must send a JSON response");
  return captured;
}

async function callBatteryDevicesHandler(snapshot) {
  let captured = null;
  const handlers = createMobileBatteryHandlers({
    batteryServiceUrl: "http://battery.test/battery",
    cacheMs: 0,
    timeoutMs: 100,
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => snapshot,
    }),
    sendJson: (_res, status, body) => {
      captured = { status, body };
    },
  });
  await handlers["mobile.batteryDevices"]({}, {});
  assert.ok(captured, "handler must send a JSON response");
  return captured;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("[BE][P1] batteria mobile aggancia il device anche con nome scritto in modo diverso", async () => {
  const response = await callBatteryHandler(
    {
      devices: [
        {
          device_id: "6e6c7652-b745-497e-b0d4-e8c947e10da3",
          device: "Amalia-4",
          level: "0.87",
          charging: "false",
          online: "true",
          client_ip: "192.168.1.198",
        },
      ],
    },
    { search: "?deviceUuid=amalia%204" }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.matched, true);
  assert.equal(response.body.matchedBy, "device_id");
  assert.equal(response.body.device.deviceName, "Amalia-4");
  assert.equal(response.body.device.level, 87);
  assert.equal(response.body.device.charging, false);
});

test("[BE][P1] batteria mobile usa l'IP del palmare quando manca il device id locale", async () => {
  const response = await callBatteryHandler(
    {
      devices: [
        {
          device_id: "old-device",
          device: "Vecchio",
          level: 10,
          online: false,
          client_ip: "192.168.1.55",
          age_seconds: 170,
        },
        {
          device_id: "fresh-device",
          device: "Palmare Sala",
          battery_level: 44,
          charging: true,
          client_ip: "192.168.1.55",
          age_seconds: 2,
        },
      ],
    },
    { remoteAddress: "::ffff:192.168.1.55" }
  );

  assert.equal(response.body.matched, true);
  assert.equal(response.body.matchedBy, "client_ip");
  assert.equal(response.body.device.deviceId, "fresh-device");
  assert.equal(response.body.device.level, 44);
  assert.equal(response.body.device.charging, true);
});

test("[BE][P1] batteria mobile accetta snapshot non standard a mappa", async () => {
  const response = await callBatteryHandler(
    {
      amalia2: {
        id: "device-map-id",
        name: "Amalia 2",
        percentage: 19,
        online: "false",
        ip: "192.168.1.88",
      },
    },
    { search: "?deviceUuid=device-map-id" }
  );

  assert.equal(response.body.matched, true);
  assert.equal(response.body.device.deviceName, "Amalia 2");
  assert.equal(response.body.device.level, 19);
  assert.equal(response.body.device.online, false);
});

test("[BE][P2] elenco batterie palmari restituisce tutti i device normalizzati", async () => {
  const response = await callBatteryDevicesHandler({
    devices: [
      {
        device_id: "offline-device",
        device: "Palmare Offline",
        percentage: 10,
        online: false,
        client_ip: "192.168.1.10",
      },
      {
        device_id: "online-device",
        device: "Palmare Online",
        battery_level: 55,
        charging: true,
        online: true,
        client_ip: "192.168.1.11",
      },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.devices.length, 2);
  assert.equal(response.body.devices[0].deviceId, "online-device");
  assert.equal(response.body.onlineCount, 1);
  assert.equal(response.body.offlineCount, 1);
  assert.equal(response.body.chargingCount, 1);
});

test("[BE][P1] stream batteria emette solo quando cambia la firma del device", async () => {
  let snapshot = {
    devices: [
      {
        device_id: "device-1",
        device: "Palmare Sala",
        level: 44,
        charging: false,
        online: true,
        client_ip: "192.168.1.55",
      },
    ],
  };
  const writes = [];
  const handlers = createMobileBatteryHandlers({
    batteryServiceUrl: "http://battery.test/battery",
    cacheMs: 60_000,
    eventPollMs: 25,
    timeoutMs: 100,
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => snapshot,
    }),
    sendJson: () => {},
  });
  const req = new EventEmitter();
  req.headers = {};
  req.socket = { remoteAddress: "::ffff:192.168.1.55" };
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.socket = {
    setTimeout() {},
    setNoDelay() {},
    setKeepAlive() {},
  };
  res.writeHead = (status, headers) => {
    writes.push(`status:${status}:${headers["Content-Type"]}`);
  };
  res.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  handlers["mobile.batteryEvents"](
    req,
    res,
    new URL("http://app.local/api/mobile/battery/events?deviceUuid=device-1")
  );

  await wait(90);
  const initialBatteryEvents = writes.filter((line) => line.includes("event: battery"));
  assert.equal(initialBatteryEvents.length, 1);

  await wait(70);
  const unchangedBatteryEvents = writes.filter((line) => line.includes("event: battery"));
  assert.equal(unchangedBatteryEvents.length, 1);

  snapshot = {
    devices: [
      {
        ...snapshot.devices[0],
        level: 45,
      },
    ],
  };
  await wait(70);
  const changedBatteryEvents = writes.filter((line) => line.includes("event: battery"));
  assert.equal(changedBatteryEvents.length, 2);

  req.emit("close");
});
