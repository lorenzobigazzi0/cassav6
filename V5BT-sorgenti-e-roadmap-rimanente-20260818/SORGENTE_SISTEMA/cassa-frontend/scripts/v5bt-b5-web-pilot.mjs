import crypto from "node:crypto";
import { createServer } from "node:http";

export const B5_WEB_PILOT_VERSION = "1.0.0";
export const B5_WEB_PILOT_MODE = "B5_7_WEB_GUI_LOOPBACK_DIAGNOSTIC";
export const REQUIRED_PING_PONG = 4;

export class B5WebPilotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B5WebPilotError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new B5WebPilotError(code, message);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) fail("REPORT_CONTRACT_INVALID", "Invalid report object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("REPORT_CONTRACT_INVALID", "Invalid report keys");
  }
}

function exact(actual, expected) {
  if (actual !== expected) fail("REPORT_CONTRACT_INVALID", "Invalid report value");
}

export function buildB5WebPilotReport({
  reachedActive = true,
  pingPongCount = REQUIRED_PING_PONG,
  closeAckCount = 1,
  errors = 0,
  connectionsAfterCleanup = 0,
  browserSessionPreserved = true,
} = {}) {
  const passed =
    reachedActive === true &&
    pingPongCount === REQUIRED_PING_PONG &&
    closeAckCount === 1 &&
    errors === 0 &&
    connectionsAfterCleanup === 0 &&
    browserSessionPreserved === true;
  return validateB5WebPilotReport({
    schemaVersion: 1,
    harnessVersion: B5_WEB_PILOT_VERSION,
    product: "V5BT",
    phase: "B5.7",
    mode: B5_WEB_PILOT_MODE,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: passed ? "NON_GATE_PASS" : "NON_GATE_FAIL",
    gateImpact: "NONE",
    target: {
      kind: "WEB_PALMARE_GUI",
      logicalSlot: 3,
      graphicalContextUsed: true,
      authenticatedAppSession: true,
    },
    transport: {
      kind: "LOOPBACK_HTTP_SIMULATION",
      loopbackOnly: true,
      bluetoothUsed: false,
      gattUsed: false,
      raspberryUsed: false,
      androidUsed: false,
    },
    lifecycle: {
      reachedActive,
      pingPongCount,
      requiredPingPongCount: REQUIRED_PING_PONG,
      closeAckCount,
      errors,
    },
    cleanup: {
      connectionsAfterCleanup,
      timersAfterCleanup: 0,
      browserSessionPreserved,
    },
    gates: {
      b4TenPhysicalDeviceGate: "PENDING",
      b5HundredSessionGate: "PENDING",
      b6AndroidPairGate: "BLOCKED",
      officialSessionsRecorded: 0,
    },
    authorization: {
      diagnosticPilotAuthorized: false,
      officialCampaignAuthorized: false,
      reasonCode: "WEB_SIMULATION_IS_NOT_PHYSICAL_EVIDENCE",
    },
    effects: {
      physicalLedgerWritten: false,
      officialCampaignStateWritten: false,
      hardwareAccessed: false,
      gatePromoted: false,
    },
    privacy: {
      browserIdentifiersIncluded: false,
      accountIdentifiersIncluded: false,
      sessionTokensIncluded: false,
      networkEndpointIncluded: false,
      physicalIdentifiersIncluded: false,
      filesystemLocationsIncluded: false,
    },
  });
}

export function validateB5WebPilotReport(report) {
  exactKeys(report, [
    "schemaVersion",
    "harnessVersion",
    "product",
    "phase",
    "mode",
    "evidenceClass",
    "verdict",
    "gateImpact",
    "target",
    "transport",
    "lifecycle",
    "cleanup",
    "gates",
    "authorization",
    "effects",
    "privacy",
  ]);
  exact(report.schemaVersion, 1);
  exact(report.harnessVersion, B5_WEB_PILOT_VERSION);
  exact(report.product, "V5BT");
  exact(report.phase, "B5.7");
  exact(report.mode, B5_WEB_PILOT_MODE);
  exact(report.evidenceClass, "NON_GATE_EVIDENCE");
  if (!new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)) {
    fail("REPORT_CONTRACT_INVALID", "Invalid non-gate verdict");
  }
  exact(report.gateImpact, "NONE");

  exactKeys(report.target, [
    "kind",
    "logicalSlot",
    "graphicalContextUsed",
    "authenticatedAppSession",
  ]);
  exact(report.target.kind, "WEB_PALMARE_GUI");
  exact(report.target.logicalSlot, 3);
  exact(report.target.graphicalContextUsed, true);
  exact(report.target.authenticatedAppSession, true);

  exactKeys(report.transport, [
    "kind",
    "loopbackOnly",
    "bluetoothUsed",
    "gattUsed",
    "raspberryUsed",
    "androidUsed",
  ]);
  exact(report.transport.kind, "LOOPBACK_HTTP_SIMULATION");
  exact(report.transport.loopbackOnly, true);
  for (const field of ["bluetoothUsed", "gattUsed", "raspberryUsed", "androidUsed"]) {
    exact(report.transport[field], false);
  }

  exactKeys(report.lifecycle, [
    "reachedActive",
    "pingPongCount",
    "requiredPingPongCount",
    "closeAckCount",
    "errors",
  ]);
  exact(report.lifecycle.requiredPingPongCount, 4);
  if (typeof report.lifecycle.reachedActive !== "boolean") {
    fail("REPORT_CONTRACT_INVALID", "Invalid ACTIVE outcome");
  }
  if (
    !Number.isInteger(report.lifecycle.pingPongCount) ||
    report.lifecycle.pingPongCount < 0 ||
    report.lifecycle.pingPongCount > REQUIRED_PING_PONG ||
    !Number.isInteger(report.lifecycle.closeAckCount) ||
    report.lifecycle.closeAckCount < 0 ||
    report.lifecycle.closeAckCount > 1 ||
    !Number.isInteger(report.lifecycle.errors) ||
    report.lifecycle.errors < 0
  ) {
    fail("REPORT_CONTRACT_INVALID", "Invalid lifecycle counters");
  }

  exactKeys(report.cleanup, [
    "connectionsAfterCleanup",
    "timersAfterCleanup",
    "browserSessionPreserved",
  ]);
  if (
    !Number.isInteger(report.cleanup.connectionsAfterCleanup) ||
    report.cleanup.connectionsAfterCleanup < 0 ||
    typeof report.cleanup.browserSessionPreserved !== "boolean"
  ) {
    fail("REPORT_CONTRACT_INVALID", "Invalid cleanup outcome");
  }
  exact(report.cleanup.timersAfterCleanup, 0);

  exactKeys(report.gates, [
    "b4TenPhysicalDeviceGate",
    "b5HundredSessionGate",
    "b6AndroidPairGate",
    "officialSessionsRecorded",
  ]);
  exact(report.gates.b4TenPhysicalDeviceGate, "PENDING");
  exact(report.gates.b5HundredSessionGate, "PENDING");
  exact(report.gates.b6AndroidPairGate, "BLOCKED");
  exact(report.gates.officialSessionsRecorded, 0);

  exactKeys(report.authorization, [
    "diagnosticPilotAuthorized",
    "officialCampaignAuthorized",
    "reasonCode",
  ]);
  exact(report.authorization.diagnosticPilotAuthorized, false);
  exact(report.authorization.officialCampaignAuthorized, false);
  exact(report.authorization.reasonCode, "WEB_SIMULATION_IS_NOT_PHYSICAL_EVIDENCE");

  exactKeys(report.effects, [
    "physicalLedgerWritten",
    "officialCampaignStateWritten",
    "hardwareAccessed",
    "gatePromoted",
  ]);
  for (const value of Object.values(report.effects)) exact(value, false);

  exactKeys(report.privacy, [
    "browserIdentifiersIncluded",
    "accountIdentifiersIncluded",
    "sessionTokensIncluded",
    "networkEndpointIncluded",
    "physicalIdentifiersIncluded",
    "filesystemLocationsIncluded",
  ]);
  for (const value of Object.values(report.privacy)) exact(value, false);

  const shouldPass =
    report.lifecycle.reachedActive === true &&
    report.lifecycle.pingPongCount === 4 &&
    report.lifecycle.closeAckCount === 1 &&
    report.lifecycle.errors === 0 &&
    report.cleanup.connectionsAfterCleanup === 0 &&
    report.cleanup.timersAfterCleanup === 0 &&
    report.cleanup.browserSessionPreserved === true;
  exact(report.verdict, shouldPass ? "NON_GATE_PASS" : "NON_GATE_FAIL");
  return Object.freeze(report);
}

function parseMessage(value) {
  try {
    const parsed = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function browserPilotClient({ url, challenge, timeoutMs }) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const exchange = async (message) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`B5_WEB_PILOT_HTTP_${response.status}`);
    return response.json();
  };
  let pingPongCount = 0;
  let closeAckCount = 0;
  try {
    let response = await exchange({ type: "CLIENT_READY", challenge });
    while (response?.type === "PING") {
      const expectedSequence = pingPongCount + 1;
      if (
        response.sequence !== expectedSequence ||
        response.challenge !== challenge
      ) {
        throw new Error("B5_WEB_PILOT_SEQUENCE_MISMATCH");
      }
      pingPongCount += 1;
      response = await exchange({
        type: "PONG",
        sequence: expectedSequence,
        challenge,
      });
    }
    if (
      response?.type !== "CLOSE" ||
      response.challenge !== challenge ||
      pingPongCount !== 4
    ) {
      throw new Error("B5_WEB_PILOT_EARLY_CLOSE");
    }
    response = await exchange({ type: "CLOSE_ACK", challenge });
    if (response?.type !== "CLOSED") {
      throw new Error("B5_WEB_PILOT_UNCLEAN_CLOSE");
    }
    closeAckCount = 1;
    return { pingPongCount, closeAckCount };
  } finally {
    window.clearTimeout(timer);
  }
}

async function closeHttpServer(server, sockets) {
  if (!server) return;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

export async function runB5WebPilot(page, { timeoutMs = 15_000 } = {}) {
  if (!page || typeof page.evaluate !== "function" || page.isClosed?.()) {
    fail("B5_WEB_PILOT_PAGE_INVALID", "An active graphical Palmare page is required");
  }
  const beforeSession = await page.evaluate(() => ({
    token: window.localStorage.getItem("pos_token") || "",
    userId: window.localStorage.getItem("pos_user_id") || "",
    deviceUuid: window.localStorage.getItem("pos_device_uuid") || "",
  }));
  if (!beforeSession.token || !beforeSession.userId || !beforeSession.deviceUuid) {
    fail("B5_WEB_PILOT_SESSION_INVALID", "The graphical Palmare is not authenticated");
  }

  const challenge = crypto.randomBytes(24).toString("base64url");
  let server = null;
  const sockets = new Set();
  let reachedActive = false;
  let pingPongCount = 0;
  let closeAckCount = 0;
  let protocolErrors = 0;
  let state = "WAIT_CLIENT_READY";
  let expectedSequence = 1;

  try {
    server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "close");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/b5-web-pilot") {
        response.writeHead(404);
        response.end();
        return;
      }
      const remote = String(request.socket.remoteAddress || "");
      if (!new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(remote)) {
        protocolErrors += 1;
        response.writeHead(403);
        response.end();
        return;
      }
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 4096) chunks.push(chunk);
      });
      request.on("end", () => {
        const message = size <= 4096 ? parseMessage(Buffer.concat(chunks)) : null;
        let reply = null;
        if (!message || message.challenge !== challenge) {
          protocolErrors += 1;
        } else if (state === "WAIT_CLIENT_READY" && message.type === "CLIENT_READY") {
          state = "ACTIVE";
          reachedActive = true;
          reply = { type: "PING", sequence: expectedSequence, challenge };
        } else if (
          state === "ACTIVE" &&
          message.type === "PONG" &&
          message.sequence === expectedSequence
        ) {
          pingPongCount += 1;
          expectedSequence += 1;
          if (pingPongCount < REQUIRED_PING_PONG) {
            reply = { type: "PING", sequence: expectedSequence, challenge };
          } else {
            state = "CLOSING";
            reply = { type: "CLOSE", challenge };
          }
        } else if (state === "CLOSING" && message.type === "CLOSE_ACK") {
          closeAckCount += 1;
          state = "CLOSED";
          reply = { type: "CLOSED" };
        } else {
          protocolErrors += 1;
        }
        if (!reply) {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ type: "ERROR" }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(reply));
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!isPlainObject(address) || !Number.isInteger(address.port)) {
      fail("B5_WEB_PILOT_ENDPOINT_INVALID", "Loopback pilot endpoint is invalid");
    }
    const clientResult = await page.evaluate(browserPilotClient, {
      url: `http://127.0.0.1:${address.port}/b5-web-pilot`,
      challenge,
      timeoutMs,
    });
    if (
      clientResult?.pingPongCount !== REQUIRED_PING_PONG ||
      clientResult?.closeAckCount !== 1 ||
      state !== "CLOSED"
    ) {
      fail("B5_WEB_PILOT_CLIENT_RESULT_INVALID", "Browser pilot counters are invalid");
    }
  } finally {
    await closeHttpServer(server, sockets).catch(() => undefined);
  }

  const afterSession = await page.evaluate(() => ({
    token: window.localStorage.getItem("pos_token") || "",
    userId: window.localStorage.getItem("pos_user_id") || "",
    deviceUuid: window.localStorage.getItem("pos_device_uuid") || "",
  }));
  const browserSessionPreserved =
    beforeSession.token === afterSession.token &&
    beforeSession.userId === afterSession.userId &&
    beforeSession.deviceUuid === afterSession.deviceUuid;
  const connectionsAfterCleanup = sockets.size;
  return buildB5WebPilotReport({
    reachedActive,
    pingPongCount,
    closeAckCount,
    errors: protocolErrors,
    connectionsAfterCleanup,
    browserSessionPreserved,
  });
}
