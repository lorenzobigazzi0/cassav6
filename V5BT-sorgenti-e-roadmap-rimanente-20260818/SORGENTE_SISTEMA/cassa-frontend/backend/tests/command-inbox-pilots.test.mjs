import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CommandInboxRepository,
  closeRelationalConnection,
  normalizeRelationalConfig,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { createCommandInboxPilot } from "../modules/command-inbox/pilot-endpoint.js";

const FIXED_NOW = "2026-07-06T10:00:00.000Z";

async function withRepo(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cassav4-command-inbox-pilot-"));
  const dbPath = path.join(dir, "relational.sqlite");
  const config = normalizeRelationalConfig({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: dbPath,
    },
    defaultDbPath: dbPath,
  });
  const db = await openRelationalConnection(config);
  try {
    await runRelationalMigrations(db, { nowIso: () => FIXED_NOW });
    const repo = new CommandInboxRepository(db, { nowIso: () => FIXED_NOW });
    return await fn(repo);
  } finally {
    closeRelationalConnection(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

// sendJson realistico: scrive su una res (reale o catturata) come backend/core/http.js.
function fakeSendJson(res, status, payload) {
  res.statusCode = status;
  if (typeof res.setHeader === "function") {
    res.setHeader("content-type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(payload));
}

function makeRecordingRes() {
  const state = { statusCode: 200, headers: {}, body: undefined };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value) {
      state.statusCode = value;
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return state.headers[String(name).toLowerCase()];
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) state.body = String(chunk);
    },
    read() {
      return {
        status: state.statusCode,
        headers: state.headers,
        json: state.body !== undefined ? JSON.parse(state.body) : undefined,
      };
    },
  };
  return res;
}

function makeReq(headers, body) {
  return { headers: headers ?? {}, __body: body ?? {} };
}

function buildPilot(repo, { mode = "enforce_pilot" } = {}) {
  const calls = { handler: 0 };
  const deps = {
    getRepository: async () => repo,
    nowIso: () => FIXED_NOW,
    sendJson: fakeSendJson,
    readJsonBody: async (req) => req.__body,
    readHeaderValue: (req, name) => req.headers[String(name).toLowerCase()],
    resolveMode: () => deps.__mode,
    ttlMs: 10 * 60 * 1000,
    isProduction: false,
    logger: { warn() {} },
  };
  deps.__mode = mode;
  const pilot = createCommandInboxPilot(deps);
  return { pilot, calls, deps };
}

// Handler fittizio idempotente: risponde 200 riecheggiando l'id ricevuto.
function makeEchoHandler(calls) {
  return async (req, res) => {
    calls.handler += 1;
    fakeSendJson(res, 200, { ok: true, echoed: req.__body.id, invocation: calls.handler });
  };
}

const ACK_OPTIONS = {
  selectIdempotencyPayload: (payload) => ({
    id: String(payload?.id ?? "").trim(),
    action: payload?.action === "delete" ? "delete" : "ack",
    consumer: String(payload?.consumer ?? "").trim() || "mobile-frontend",
  }),
  aggregate: (payload) => ({
    aggregateType: "notification",
    aggregateId: String(payload?.id ?? "").trim(),
  }),
};

const IDEMPOTENT_HEADERS = {
  "x-command-request-id": "req-001",
  "x-idempotency-key": "device-1:ack-1",
  "x-device-uuid": "device-1",
};

test("created → esegue handler e memoizza risposta 2xx", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);
    const res = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, { id: "n1", action: "ack" }), res);

    assert.equal(calls.handler, 1);
    assert.deepEqual(res.read().json, { ok: true, echoed: "n1", invocation: 1 });
    assert.equal(repo.countSummary().committed, 1);
    const record = repo.getByRequestId("req-001");
    assert.equal(record.status, "committed");
    assert.equal(record.result.status, 200);
  });
});

test("replay committed → handler NON rieseguito, risposta salvata restituita", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);
    const body = { id: "n1", action: "ack" };

    const first = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, body), first);
    const second = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, body), second);

    assert.equal(calls.handler, 1, "handler eseguito una sola volta");
    assert.deepEqual(second.read().json, first.read().json);
    assert.equal(second.read().status, 200);
  });
});

test("doppio-tap concorrente (processing) → 409 in-progress", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);
    // Lascia un record in processing con lo stesso requestId.
    repo.begin({
      requestId: "req-001",
      idempotencyKey: "device-1:ack-1",
      deviceId: "device-1",
      commandType: "notifications.ack",
      aggregateType: "notification",
      aggregateId: "n1",
      payload: { id: "n1", action: "ack", consumer: "mobile-frontend" },
    });

    const res = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, { id: "n1", action: "ack" }), res);

    assert.equal(calls.handler, 0, "handler non eseguito mentre e' in corso");
    assert.equal(res.read().status, 409);
    assert.equal(res.read().json.code, "COMMAND_IN_PROGRESS");
    assert.equal(res.read().headers["retry-after"], "1");
  });
});

test("stessa idempotency key con payload diverso → 409 conflict", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);

    const first = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, { id: "n1", action: "ack" }), first);
    assert.equal(calls.handler, 1);

    // Stessa idempotency key, requestId diverso, action diversa → payload hash diverso.
    const conflictHeaders = {
      ...IDEMPOTENT_HEADERS,
      "x-command-request-id": "req-002",
    };
    const second = makeRecordingRes();
    await handler(makeReq(conflictHeaders, { id: "n1", action: "delete" }), second);

    assert.equal(calls.handler, 1, "handler non rieseguito su conflict");
    assert.equal(second.read().status, 409);
    assert.equal(second.read().json.code, "COMMAND_PAYLOAD_CONFLICT");
  });
});

test("shadow → nessun short-circuit: handler rieseguito, esito osservato", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo, { mode: "shadow" });
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);
    const body = { id: "n1", action: "ack" };

    const first = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, body), first);
    const second = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, body), second);

    assert.equal(calls.handler, 2, "in shadow l'handler gira sempre live");
    assert.equal(second.read().status, 200);
    // Il primo comando resta memoizzato per osservazione.
    assert.equal(repo.getByRequestId("req-001").status, "committed");
  });
});

test("client legacy senza idempotenza → path invariato, nessun record inbox", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);

    const res = makeRecordingRes();
    await handler(makeReq({}, { id: "n1", action: "ack" }), res);

    assert.equal(calls.handler, 1);
    assert.equal(res.read().json.ok, true);
    assert.equal(repo.countSummary().processing, 0);
    assert.equal(repo.countSummary().committed, 0);
  });
});

test("flag off (mode=off) → bypass totale, repository non toccato", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls, deps } = buildPilot(repo, { mode: "off" });
    let repoRequested = false;
    deps.getRepository = async () => {
      repoRequested = true;
      return repo;
    };
    const handler = pilot.wrap("notifications.ack", makeEchoHandler(calls), ACK_OPTIONS);

    const res = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, { id: "n1", action: "ack" }), res);

    assert.equal(calls.handler, 1);
    assert.equal(repoRequested, false, "in off il repository non viene nemmeno richiesto");
    assert.equal(repo.countSummary().committed, 0);
  });
});

test("shouldEngage falso (es. stampa fiscale) → bypass, nessun record", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const handler = pilot.wrap("print.request", makeEchoHandler(calls), {
      ...ACK_OPTIONS,
      shouldEngage: (payload) => payload.kind === "order" || payload.kind === "preconto",
    });

    const res = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, { id: "x", kind: "fiscale" }), res);

    assert.equal(calls.handler, 1);
    assert.equal(repo.countSummary().processing, 0);
    assert.equal(repo.countSummary().committed, 0);
  });
});

test("handler che lancia HttpError 4xx → memoizza rejected e rilancia", async () => {
  await withRepo(async (repo) => {
    const { pilot, calls } = buildPilot(repo);
    const throwingHandler = async () => {
      calls.handler += 1;
      const error = new Error("ID notifica non valido.");
      error.status = 400;
      error.code = "INVALID_ID";
      throw error;
    };
    const handler = pilot.wrap("notifications.ack", throwingHandler, ACK_OPTIONS);

    const res = makeRecordingRes();
    await assert.rejects(
      () => handler(makeReq(IDEMPOTENT_HEADERS, { id: "n1", action: "ack" }), res),
      /ID notifica non valido/,
    );

    assert.equal(calls.handler, 1);
    const record = repo.getByRequestId("req-001");
    assert.equal(record.status, "rejected");
    assert.equal(record.result.status, 400);
    assert.equal(record.result.json.code, "INVALID_ID");

    // Replay dell'errore memoizzato non riesegue l'handler.
    const replay = makeRecordingRes();
    await handler(makeReq(IDEMPOTENT_HEADERS, { id: "n1", action: "ack" }), replay);
    assert.equal(calls.handler, 1, "replay non riesegue l'handler");
    assert.equal(replay.read().status, 400);
    assert.equal(replay.read().json.code, "INVALID_ID");
  });
});
