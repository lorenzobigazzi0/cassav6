#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const RADIO_MAGIC = "RPT1";
const RADIO_HEADER_BYTES = 16;

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date();
const errors = [];
const metricMap = new Map();

function parseArgs(argv) {
  const parsed = {
    baseUrl: process.env.MEGA_SIM_BASE_URL || process.env.BASE_URL || "https://127.0.0.1:5280",
    username: process.env.MEGA_SIM_USERNAME || process.env.POS_USERNAME || "admin",
    pin: process.env.MEGA_SIM_PIN || process.env.POS_PIN || "1234",
    devices: Number(process.env.MEGA_SIM_DEVICES || 100),
    stations: Number(process.env.MEGA_SIM_STATIONS || 10),
    durationMs: Number(process.env.MEGA_SIM_DURATION_MS || 45_000),
    thinkMs: Number(process.env.MEGA_SIM_THINK_MS || 180),
    timeoutMs: Number(process.env.MEGA_SIM_TIMEOUT_MS || 8_000),
    loginConcurrency: Number(process.env.MEGA_SIM_LOGIN_CONCURRENCY || 20),
    radioClients: Number(process.env.MEGA_SIM_RADIO_CLIENTS || 100),
    output: process.env.MEGA_SIM_OUTPUT || "scripts/mega-sim-100-devices.last.json",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--base-url") parsed.baseUrl = String(argv[++index] ?? "").trim();
    else if (arg.startsWith("--base-url=")) parsed.baseUrl = arg.slice("--base-url=".length).trim();
    else if (arg === "--username") parsed.username = String(argv[++index] ?? "").trim();
    else if (arg.startsWith("--username=")) parsed.username = arg.slice("--username=".length).trim();
    else if (arg === "--pin") parsed.pin = String(argv[++index] ?? "").trim();
    else if (arg.startsWith("--pin=")) parsed.pin = arg.slice("--pin=".length).trim();
    else if (arg === "--devices") parsed.devices = Number(argv[++index]);
    else if (arg.startsWith("--devices=")) parsed.devices = Number(arg.slice("--devices=".length));
    else if (arg === "--stations") parsed.stations = Number(argv[++index]);
    else if (arg.startsWith("--stations=")) parsed.stations = Number(arg.slice("--stations=".length));
    else if (arg === "--duration-ms") parsed.durationMs = Number(argv[++index]);
    else if (arg.startsWith("--duration-ms=")) parsed.durationMs = Number(arg.slice("--duration-ms=".length));
    else if (arg === "--think-ms") parsed.thinkMs = Number(argv[++index]);
    else if (arg.startsWith("--think-ms=")) parsed.thinkMs = Number(arg.slice("--think-ms=".length));
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--radio-clients") parsed.radioClients = Number(argv[++index]);
    else if (arg.startsWith("--radio-clients=")) parsed.radioClients = Number(arg.slice("--radio-clients=".length));
    else if (arg === "--output") parsed.output = String(argv[++index] ?? "").trim();
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length).trim();
  }

  parsed.baseUrl = String(parsed.baseUrl || "").replace(/\/+$/, "");
  parsed.devices = clampInt(parsed.devices, 1, 500, 100);
  parsed.stations = clampInt(parsed.stations, 1, 100, 10);
  parsed.durationMs = clampInt(parsed.durationMs, 5_000, 300_000, 45_000);
  parsed.thinkMs = clampInt(parsed.thinkMs, 0, 5_000, 180);
  parsed.timeoutMs = clampInt(parsed.timeoutMs, 1_000, 60_000, 8_000);
  parsed.loginConcurrency = clampInt(parsed.loginConcurrency, 1, 100, 20);
  parsed.radioClients = clampInt(parsed.radioClients, 0, parsed.devices, Math.min(100, parsed.devices));
  parsed.output = parsed.output || "";
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function printHelp() {
  console.log(`Uso:
  node scripts/mega-sim-100-devices.mjs --base-url https://127.0.0.1:5280 --username admin --pin 1234

Opzioni:
  --devices N          device mobile simulati, default 100
  --stations N         postazioni simulate, default 10
  --duration-ms N      durata carico REST, default 45000
  --think-ms N         pausa media tra richieste per device, default 180
  --radio-clients N    socket radio da aprire, default uguale ai device fino a 100
  --output PATH        report JSON, default scripts/mega-sim-100-devices.last.json
`);
}

function endpoint(path) {
  return new URL(path, `${options.baseUrl}/`).toString();
}

function wsEndpoint(path) {
  const url = new URL(endpoint(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.userId,
    "X-Device-Uuid": session.deviceUuid,
  };
}

function authBody(session, extra = {}) {
  return {
    token: session.token,
    userId: session.userId,
    deviceUuid: session.deviceUuid,
    clientApp: session.clientApp,
    ...extra,
  };
}

function metric(name) {
  if (!metricMap.has(name)) {
    metricMap.set(name, { name, count: 0, ok: 0, fail: 0, latencies: [], statusCodes: new Map() });
  }
  return metricMap.get(name);
}

function record(name, ok, ms, statusCode = 0, detail = "") {
  const item = metric(name);
  item.count += 1;
  if (ok) item.ok += 1;
  else item.fail += 1;
  item.latencies.push(ms);
  if (statusCode) {
    item.statusCodes.set(statusCode, (item.statusCodes.get(statusCode) ?? 0) + 1);
  }
  if (!ok && errors.length < 50) {
    errors.push({ name, statusCode, detail: String(detail || "").slice(0, 500) });
  }
}

async function requestJson(name, path, init = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  let statusCode = 0;
  try {
    const response = await fetch(endpoint(path), {
      method: init.method || "GET",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    statusCode = response.status;
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    const expected = init.expectStatus || [200];
    const ok = expected.includes(response.status);
    record(name, ok, performance.now() - started, statusCode, ok ? "" : body?.error || body?.raw || text);
    if (!ok) throw new Error(`${name} HTTP ${response.status}: ${body?.error || body?.raw || text}`);
    return body;
  } catch (error) {
    record(name, false, performance.now() - started, statusCode, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function roomIdFor(session, rooms) {
  if (session.roomId) return session.roomId;
  const room = rooms[session.index % Math.max(1, rooms.length)];
  return room?.id || room?.roomId || "room_pedana";
}

async function loginDevice(index) {
  const deviceUuid = `codex-mega-sim-mobile-${String(index + 1).padStart(3, "0")}-${Date.now()}`;
  const body = await requestJson("auth.login", "/api/auth/login", {
    method: "POST",
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid,
      clientApp: "mobile-frontend",
    },
  });
  if (body?.ok !== true || !body.token || !body.user?.id) {
    throw new Error(`login non valido per device ${index + 1}`);
  }
  return {
    index,
    token: body.token,
    userId: body.user.id,
    username: body.user.username || options.username,
    fullName: body.user.fullName || body.user.username || options.username,
    role: body.user.role || "admin",
    permissions: body.user.permissions || [],
    deviceUuid,
    clientApp: "mobile-frontend",
    roomId: "",
  };
}

async function logoutDevice(session) {
  try {
    await requestJson("auth.logout", "/api/auth/logout", {
      method: "POST",
      headers: authHeaders(session),
      body: authBody(session),
      expectStatus: [200, 401],
    });
  } catch {
    // Errors are already counted. Cleanup is best-effort.
  }
}

async function cleanupStations(stationSessions) {
  await mapLimit(stationSessions, 10, async ({ session, station }) => {
    try {
      await requestJson("postazione.state.cleanup", "/api/integration/stations/state", {
        method: "POST",
        body: {
          ...authBody(session, {
            clientApp: "postazione",
            station,
            stationName: station,
            active: false,
            operatorName: session.fullName,
            operatorUsername: session.username,
            operatorUserId: session.userId,
            operatorRole: session.role,
          }),
        },
      });
    } catch {
      // Best-effort cleanup.
    }
  });
}

function buildTaskList(sessions, rooms, stations) {
  const stationPairs = stations.map((station, index) => ({
    station,
    session: sessions[index % sessions.length],
  }));
  const serviceDate = todayIso();
  return [
    {
      name: "health",
      weight: 4,
      run: (session) => requestJson("health", `/api/health?_=${Date.now()}`),
    },
    {
      name: "layout",
      weight: 8,
      run: () => requestJson("integration.layout", `/api/integration/layout?_=${Date.now()}`),
    },
    {
      name: "orders",
      weight: 8,
      run: (session) =>
        requestJson(
          "integration.orders",
          `/api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1&roomId=${encodeURIComponent(roomIdFor(session, rooms))}&_=${Date.now()}`,
        ),
    },
    {
      name: "table-groups",
      weight: 5,
      run: (session) =>
        requestJson("integration.table-groups", `/api/integration/table-groups?_=${Date.now()}`, {
          headers: authHeaders(session),
        }),
    },
    {
      name: "active-stations",
      weight: 3,
      run: () => requestJson("integration.stations.active", `/api/integration/stations/active?_=${Date.now()}`),
    },
    {
      name: "station-heartbeat",
      weight: 5,
      run: (session) => {
        const pair = stationPairs[session.index % stationPairs.length];
        return requestJson("postazione.state.heartbeat", "/api/integration/stations/state", {
          method: "POST",
          body: {
            ...authBody(pair.session, {
              clientApp: "postazione",
              station: pair.station,
              stationName: pair.station,
              active: true,
              autoPrintOrders: false,
              autoPrintPreconto: false,
              operatorName: pair.session.fullName,
              operatorUsername: pair.session.username,
              operatorUserId: pair.session.userId,
              operatorRole: pair.session.role,
            }),
          },
        });
      },
    },
    {
      name: "mobile-rooms",
      weight: 5,
      run: (session) =>
        requestJson("pos.rooms", "/api/pos/rooms", {
          method: "POST",
          headers: authHeaders(session),
          body: authBody(session, { role: session.role, currentRoomId: roomIdFor(session, rooms) }),
        }),
    },
    {
      name: "reservations-list",
      weight: 5,
      run: (session) =>
        requestJson("reservations.list", "/api/pos/reservations/list", {
          method: "POST",
          headers: authHeaders(session),
          body: authBody(session, {
            roomId: roomIdFor(session, rooms),
            serviceDate,
          }),
        }),
    },
    {
      name: "menu-catalog",
      weight: 4,
      run: (session) =>
        requestJson("menu.catalog", "/api/menu/catalog", {
          method: "POST",
          headers: authHeaders(session),
          body: authBody(session),
        }),
    },
    {
      name: "integration-menu-public",
      weight: 3,
      run: () => requestJson("integration.menu", `/api/integration/menu?_=${Date.now()}`),
    },
    {
      name: "waiter-pause",
      weight: 3,
      run: (session) =>
        requestJson("waiter.pause.status", "/api/mobile/waiter-pause/status", {
          method: "POST",
          headers: authHeaders(session),
          body: authBody(session, {
            roomId: roomIdFor(session, rooms),
            roomName: rooms.find((room) => (room.id || room.roomId) === roomIdFor(session, rooms))?.name || "",
          }),
        }),
    },
    {
      name: "radio-config",
      weight: 3,
      run: (session) =>
        requestJson("radio.config", "/api/mobile/radio/config", {
          method: "POST",
          headers: authHeaders(session),
          body: authBody(session),
        }),
    },
    {
      name: "battery",
      weight: 2,
      run: (session) =>
        requestJson(
          "mobile.battery",
          `/api/mobile/battery?deviceUuid=${encodeURIComponent(session.deviceUuid)}&_=${Date.now()}`,
          { headers: authHeaders(session), expectStatus: [200] },
        ),
    },
    {
      name: "automatic-cash-status",
      weight: 2,
      run: (session) =>
        requestJson("automatic-cash.status", `/api/automatic-cash/status?_=${Date.now()}`, {
          headers: authHeaders(session),
        }),
    },
    {
      name: "automatic-cash-active",
      weight: 1,
      run: (session) =>
        requestJson("automatic-cash.active-float", `/api/automatic-cash/cash-float/active?_=${Date.now()}`, {
          headers: authHeaders(session),
        }),
    },
    {
      name: "settings-pos",
      weight: 2,
      run: (session) =>
        requestJson("settings.pos", "/api/settings/pos", {
          method: "POST",
          headers: authHeaders(session),
          body: authBody(session),
        }),
    },
    {
      name: "monitor-overview",
      weight: 1,
      run: () => requestJson("monitor.overview", `/api/monitor/overview?_=${Date.now()}`),
    },
  ];
}

function weightedPicker(tasks) {
  const expanded = [];
  for (const task of tasks) {
    for (let index = 0; index < task.weight; index += 1) expanded.push(task);
  }
  return () => expanded[Math.floor(Math.random() * expanded.length)];
}

async function runRestLoad(sessions, rooms, stations) {
  const tasks = buildTaskList(sessions, rooms, stations);
  const pick = weightedPicker(tasks);
  const endAt = performance.now() + options.durationMs;
  await Promise.all(
    sessions.map(async (session) => {
      while (performance.now() < endAt) {
        const task = pick();
        try {
          await task.run(session);
        } catch {
          // Individual failures are already recorded.
        }
        if (options.thinkMs > 0) {
          const jitter = Math.floor(Math.random() * options.thinkMs);
          await sleep(Math.max(0, options.thinkMs - Math.floor(options.thinkMs / 2) + jitter));
        }
      }
    }),
  );
}

function buildRadioFrame(streamId, seq, payloadSize = 160) {
  const buffer = Buffer.alloc(RADIO_HEADER_BYTES + payloadSize);
  buffer.write(RADIO_MAGIC, 0, 4, "ascii");
  buffer.writeUInt32BE(Number(streamId) >>> 0, 4);
  buffer.writeUInt32BE(Number(seq) >>> 0, 8);
  buffer.writeUInt32BE(Date.now() >>> 0, 12);
  for (let index = RADIO_HEADER_BYTES; index < buffer.length; index += 1) {
    buffer[index] = (seq + index) % 255;
  }
  return buffer;
}

function waitForRadioEvent(client, predicate, timeoutMs = options.timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout evento radio"));
    }, timeoutMs);
    function onEvent(message) {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }
    function cleanup() {
      clearTimeout(timeout);
      client.listeners.delete(onEvent);
    }
    client.listeners.add(onEvent);
  });
}

async function openRadioClient(session, channelIds) {
  const started = performance.now();
  const socket = new WebSocket(wsEndpoint("/api/radio/ws"), {
    rejectUnauthorized: false,
    perMessageDeflate: false,
  });
  const client = {
    session,
    socket,
    listeners: new Set(),
    binaryFrames: 0,
    incomingStarts: 0,
    incomingStops: 0,
    busy: 0,
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      client.binaryFrames += 1;
      return;
    }
    let message = null;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.type === "ptt:incoming-start") client.incomingStarts += 1;
    if (message?.type === "ptt:incoming-stop") client.incomingStops += 1;
    if (message?.type === "ptt:busy") client.busy += 1;
    for (const listener of [...client.listeners]) listener(message);
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout apertura radio WS")), options.timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  socket.send(
    JSON.stringify({
      type: "hello",
      token: session.token,
      userId: session.userId,
      deviceUuid: session.deviceUuid,
      clientApp: session.clientApp,
      protocolVersion: 1,
    }),
  );
  await waitForRadioEvent(client, (message) => message?.type === "ready");
  socket.send(JSON.stringify({ type: "subscribe", channelIds }));
  await waitForRadioEvent(client, (message) => message?.type === "subscribed");
  record("radio.ws.open", true, performance.now() - started, 101);
  return client;
}

async function runRadioSim(sessions, channels) {
  const enabledChannels = channels.filter((channel) => channel?.id && channel.enabled !== false);
  if (options.radioClients <= 0 || enabledChannels.length === 0) {
    record("radio.ws.skipped", true, 0, 0, "nessun canale radio attivo o radio-clients=0");
    return { skipped: true, reason: "nessun canale radio attivo" };
  }

  const channelIds = enabledChannels.map((channel) => channel.id);
  const clients = [];
  try {
    const selectedSessions = sessions.slice(0, options.radioClients);
    const opened = await mapLimit(selectedSessions, 25, async (session) => {
      try {
        return await openRadioClient(session, channelIds);
      } catch (error) {
        record("radio.ws.open", false, options.timeoutMs, 0, error instanceof Error ? error.message : String(error));
        return null;
      }
    });
    clients.push(...opened.filter(Boolean));

    if (clients.length < 2) {
      return { clients: clients.length, error: "meno di 2 radio client pronti" };
    }

    const echoClient = clients[0];
    const echoTxId = `echo_sim_${Date.now()}`;
    const echoStarted = performance.now();
    echoClient.socket.send(JSON.stringify({ type: "echo:start", txId: echoTxId, codec: "mulaw", sampleRate: 16000, frameMs: 20 }));
    const echoGrant = await waitForRadioEvent(echoClient, (message) => message?.type === "echo:grant" && message.txId === echoTxId);
    for (let seq = 0; seq < 35; seq += 1) {
      echoClient.socket.send(buildRadioFrame(echoGrant.streamId, seq));
      await sleep(8);
    }
    echoClient.socket.send(JSON.stringify({ type: "echo:stop", txId: echoTxId }));
    await waitForRadioEvent(echoClient, (message) => message?.type === "echo:stop" && message.txId === echoTxId, 5000).catch(() => null);
    const echoOk = echoClient.binaryFrames >= 20;
    record("radio.echo.frames", echoOk, performance.now() - echoStarted, echoOk ? 200 : 500, `${echoClient.binaryFrames} frame ricevuti`);

    const speaker = clients[0];
    const channelId = channelIds[0];
    const pttTxId = `ptt_sim_${Date.now()}`;
    const pttStarted = performance.now();
    speaker.socket.send(
      JSON.stringify({
        type: "ptt:start",
        txId: pttTxId,
        channelId,
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    const grant = await waitForRadioEvent(speaker, (message) => message?.type === "ptt:grant" && message.txId === pttTxId);

    const busyClients = clients.slice(1, 8);
    for (const client of busyClients) {
      client.socket.send(
        JSON.stringify({
          type: "ptt:start",
          txId: `busy_${Date.now()}_${client.session.index}`,
          channelId,
          codec: "mulaw",
          sampleRate: 16000,
          frameMs: 20,
        }),
      );
    }

    for (let seq = 0; seq < 60; seq += 1) {
      speaker.socket.send(buildRadioFrame(grant.streamId, seq));
      await sleep(8);
    }
    speaker.socket.send(JSON.stringify({ type: "ptt:stop", txId: pttTxId }));
    await sleep(300);

    const receivers = clients.slice(1);
    const totalIncoming = receivers.reduce((sum, client) => sum + client.incomingStarts, 0);
    const totalFrames = receivers.reduce((sum, client) => sum + client.binaryFrames, 0);
    const totalBusy = busyClients.reduce((sum, client) => sum + client.busy, 0);
    record(
      "radio.ptt.broadcast",
      totalIncoming >= Math.max(1, receivers.length - 2) && totalFrames > 0,
      performance.now() - pttStarted,
      totalFrames > 0 ? 200 : 500,
      `${receivers.length} ricevitori, ${totalIncoming} start, ${totalFrames} frame`,
    );
    record(
      "radio.ptt.busy-lock",
      totalBusy >= Math.min(1, busyClients.length),
      0,
      totalBusy > 0 ? 200 : 500,
      `${totalBusy}/${busyClients.length} busy`,
    );
    return {
      clients: clients.length,
      channelIds,
      echoFrames: echoClient.binaryFrames,
      pttIncomingStarts: totalIncoming,
      pttFramesReceived: totalFrames,
      busyResponses: totalBusy,
    };
  } finally {
    for (const client of clients) {
      try {
        client.socket.close();
      } catch {
        // Ignore close races.
      }
    }
  }
}

function snapshotProcesses() {
  const command = `
$ports = @(5280,5281,8765,3306)
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }
$pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
$items = foreach ($ownerPid in $pids) {
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($proc) {
    [PSCustomObject]@{
      Id = $proc.Id
      ProcessName = $proc.ProcessName
      CPU = [double]($proc.CPU)
      WorkingSet64 = [int64]($proc.WorkingSet64)
      Ports = @(($listeners | Where-Object { $_.OwningProcess -eq $proc.Id } | Select-Object -ExpandProperty LocalPort))
    }
  }
}
$items | ConvertTo-Json -Compress
`;
  try {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function summarizeMetrics() {
  return [...metricMap.values()]
    .map((entry) => {
      const sorted = [...entry.latencies].sort((a, b) => a - b);
      return {
        name: entry.name,
        count: entry.count,
        ok: entry.ok,
        fail: entry.fail,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted.length ? round(sorted[sorted.length - 1]) : 0,
        statusCodes: Object.fromEntries([...entry.statusCodes.entries()].sort((a, b) => a[0] - b[0])),
      };
    })
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return round(sorted[index]);
}

function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

function summarizeProcesses(before, after, elapsedMs) {
  const beforeById = new Map(before.map((entry) => [entry.Id, entry]));
  const cores = Math.max(1, cpus().length);
  return after.map((entry) => {
    const previous = beforeById.get(entry.Id);
    const cpuDeltaSeconds =
      previous && Number.isFinite(Number(entry.CPU)) && Number.isFinite(Number(previous.CPU))
        ? Number(entry.CPU) - Number(previous.CPU)
        : null;
    const oneCorePct =
      cpuDeltaSeconds === null ? null : round((cpuDeltaSeconds / Math.max(1, elapsedMs / 1000)) * 100);
    return {
      id: entry.Id,
      processName: entry.ProcessName,
      ports: entry.Ports,
      cpuDeltaSeconds: cpuDeltaSeconds === null ? null : round(cpuDeltaSeconds),
      oneCorePct,
      machinePct: oneCorePct === null ? null : round(oneCorePct / cores),
      workingSetMb: round(Number(entry.WorkingSet64 || 0) / 1024 / 1024),
      workingSetDeltaMb: previous
        ? round((Number(entry.WorkingSet64 || 0) - Number(previous.WorkingSet64 || 0)) / 1024 / 1024)
        : null,
    };
  });
}

function writeReport(report) {
  if (!options.output) return "";
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return options.output;
}

async function discoverRoomsAndRadio(session) {
  const roomsPayload = await requestJson("preflight.pos.rooms", "/api/pos/rooms", {
    method: "POST",
    headers: authHeaders(session),
    body: authBody(session, { role: session.role }),
  });
  const rooms = Array.isArray(roomsPayload?.rooms) ? roomsPayload.rooms : [];
  const radioPayload = await requestJson("preflight.radio.config", "/api/mobile/radio/config", {
    method: "POST",
    headers: authHeaders(session),
    body: authBody(session),
  });
  const channels = Array.isArray(radioPayload?.channels) ? radioPayload.channels : [];
  return { rooms, channels };
}

async function discoverStationNames() {
  try {
    const payload = await requestJson("preflight.stations.active", `/api/integration/stations/active?_=${Date.now()}`);
    const configured = Array.isArray(payload?.configuredStations)
      ? payload.configuredStations
          .map((entry) => String(entry?.name ?? entry?.station ?? entry ?? "").trim())
          .filter(Boolean)
      : [];
    const names = configured.slice(0, options.stations);
    while (names.length < options.stations) names.push(`CodexSim${names.length + 1}`);
    return names;
  } catch {
    return Array.from({ length: options.stations }, (_, index) => `CodexSim${index + 1}`);
  }
}

async function main() {
  if (options.help) {
    printHelp();
    return;
  }

  console.log(`[mega-sim] target=${options.baseUrl} devices=${options.devices} stations=${options.stations} durationMs=${options.durationMs}`);
  const processBefore = snapshotProcesses();
  const wallStart = performance.now();

  await requestJson("preflight.health", "/api/health");
  console.log("[mega-sim] login device...");
  const sessions = await mapLimit(
    Array.from({ length: options.devices }, (_, index) => index),
    options.loginConcurrency,
    (index) => loginDevice(index),
  );
  const { rooms, channels } = await discoverRoomsAndRadio(sessions[0]);
  for (const session of sessions) {
    const room = rooms[session.index % Math.max(1, rooms.length)];
    session.roomId = String(room?.id ?? room?.roomId ?? "").trim();
  }
  const stations = await discoverStationNames();
  console.log(`[mega-sim] rooms=${rooms.length} radioChannels=${channels.length} stationNames=${stations.join(", ")}`);

  const radioPromise = runRadioSim(sessions, channels).catch((error) => {
    record("radio.sim", false, 0, 0, error instanceof Error ? error.message : String(error));
    return { error: error instanceof Error ? error.message : String(error) };
  });
  console.log("[mega-sim] REST load in corso...");
  await runRestLoad(sessions, rooms, stations);
  const radio = await radioPromise;

  const stationSessions = stations.map((station, index) => ({ station, session: sessions[index % sessions.length] }));
  await cleanupStations(stationSessions);
  await mapLimit(sessions, 20, logoutDevice);

  const elapsedMs = performance.now() - wallStart;
  const processAfter = snapshotProcesses();
  const report = {
    ok: [...metricMap.values()].every((entry) => entry.fail === 0),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target: options.baseUrl,
    options,
    elapsedMs: round(elapsedMs),
    database: "see /api/health metric payload",
    rooms: rooms.length,
    radio,
    metrics: summarizeMetrics(),
    errors,
    processes: summarizeProcesses(processBefore, processAfter, elapsedMs),
  };
  const output = writeReport(report);

  const total = report.metrics.reduce((sum, entry) => sum + entry.count, 0);
  const failed = report.metrics.reduce((sum, entry) => sum + entry.fail, 0);
  console.log(`[mega-sim] richieste/eventi=${total} falliti=${failed} elapsed=${round(elapsedMs / 1000)}s`);
  console.log("[mega-sim] top metriche:");
  for (const entry of report.metrics.slice(0, 20)) {
    console.log(
      `  ${entry.name}: count=${entry.count} fail=${entry.fail} p50=${entry.p50Ms}ms p95=${entry.p95Ms}ms p99=${entry.p99Ms}ms max=${entry.maxMs}ms`,
    );
  }
  console.log("[mega-sim] processi:");
  for (const proc of report.processes) {
    console.log(
      `  ${proc.processName}#${proc.id} ports=${JSON.stringify(proc.ports)} cpu=${proc.oneCorePct}%core/${proc.machinePct}%machine rss=${proc.workingSetMb}MB delta=${proc.workingSetDeltaMb}MB`,
    );
  }
  if (output) console.log(`[mega-sim] report=${output}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
