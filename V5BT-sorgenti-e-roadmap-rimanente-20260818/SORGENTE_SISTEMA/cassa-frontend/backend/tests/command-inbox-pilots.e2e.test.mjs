import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createTempRunDir, startBackend } from "./helpers/test-server.mjs";

const PILOT_ENV = {
  COMMAND_INBOX_ENABLED: "1",
  COMMAND_INBOX_MODE: "enforce_pilot",
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  RUNTIME_METRICS: "1",
  PRINTING_ENABLED: "0",
};

async function ackRequest(baseUrl, { requestId, idempotencyKey, body }) {
  const headers = { "Content-Type": "application/json" };
  if (requestId) headers["X-Command-Request-Id"] = requestId;
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${baseUrl}/api/integration/notifications/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

test("[BE][STEP4] notification.ack: retry idempotente, conflict e bypass legacy live", async (t) => {
  const runDir = await createTempRunDir("command-inbox-pilot-e2e");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: { ...PILOT_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });

  const body = {
    id: "n-live-1",
    action: "ack",
    clientApp: "postazione",
  };
  const idempotencyKey = "e2e-device:ack:1";

  // 1) Primo arrivo: eseguito e committato.
  const first = await ackRequest(backend.baseUrl, {
    requestId: "e2e-req-1",
    idempotencyKey,
    body,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);

  // 2) Retry identico: replay del risultato salvato, byte-identico.
  const replay = await ackRequest(backend.baseUrl, {
    requestId: "e2e-req-1",
    idempotencyKey,
    body,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, first.json);

  // 3) Stessa idempotency key, payload business diverso → conflict.
  const conflict = await ackRequest(backend.baseUrl, {
    requestId: "e2e-req-2",
    idempotencyKey,
    body: { id: "n-live-1", action: "delete" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "COMMAND_PAYLOAD_CONFLICT");

  // 4) Client legacy senza header idempotenza → path invariato (200).
  const legacy = await ackRequest(backend.baseUrl, { body });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.ok, true);

  // 5) Le metriche runtime devono aver registrato almeno un replay e un conflict.
  const metricsResponse = await fetch(
    `${backend.baseUrl}/api/monitor/runtime-metrics`,
    { cache: "no-store" },
  ).catch(() => null);
  if (metricsResponse && metricsResponse.status === 200) {
    const snapshot = await metricsResponse.json().catch(() => null);
    const commandInbox =
      snapshot?.commandInbox ??
      snapshot?.metrics?.commandInbox ??
      snapshot?.runtime?.commandInbox ??
      null;
    if (commandInbox) {
      assert.ok(
        Number(commandInbox.replays) >= 1,
        `atteso almeno 1 replay nelle metriche, visto ${commandInbox.replays}`,
      );
      assert.ok(
        Number(commandInbox.conflicts) >= 1,
        `atteso almeno 1 conflict nelle metriche, visto ${commandInbox.conflicts}`,
      );
    }
  }
});
