import assert from "node:assert/strict";
import test from "node:test";

import { hashPin, verifyPinAsync } from "../auth/password.js";
import { createRoomChangeApprovePinProofService } from "../modules/pos-rooms/room-change-approve-pin-proof.js";

const APPROVE_PATH = "/api/pos/room-change/approve";

function createUser(overrides = {}) {
  return {
    id: "u_manager",
    username: "manager",
    pinHash: "pin-hash-v1",
    role: "responsabile",
    ...overrides,
  };
}

function createRequest(overrides = {}) {
  return {
    method: "POST",
    __jsonBodyPayload: {
      requestId: "room-request-1",
      approverUsername: "manager",
      approverPin: "4444",
      deviceUuid: "device-manager",
      ...overrides,
    },
  };
}

function createHarness({ pinValid = true } = {}) {
  const user = createUser();
  const events = [];
  const service = createRoomChangeApprovePinProofService({
    enabled: true,
    readDb: async () => ({ users: [user] }),
    verifyPinAsync: async () => pinValid,
    normalizeUsername: (value) => String(value ?? "").trim().toLowerCase(),
    normalizeRole: (value) => String(value ?? "").trim().toLowerCase(),
    isPrivilegedRole: (role) => ["admin", "responsabile"].includes(String(role ?? "").trim().toLowerCase()),
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        events.push({ kind, label, durationMs });
      },
    },
  });
  return { user, events, service };
}

test("verifyPinAsync mantiene formato e confronto timing-safe senza bloccare il tick", async () => {
  const pinHash = hashPin("4444");
  let tickObserved = false;
  const verification = verifyPinAsync("4444", pinHash);
  setImmediate(() => { tickObserved = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tickObserved, true);
  assert.equal(await verification, true);
  assert.equal(await verifyPinAsync("0000", pinHash), false);
  assert.equal(await verifyPinAsync("4444", "hash-non-valido"), false);
});

test("la prova valida e' effimera, non serializzata e consumabile una sola volta", async () => {
  const { user, events, service } = createHarness();
  const req = createRequest();

  assert.deepEqual(await service.prepare(req, APPROVE_PATH), { prepared: true });
  assert.equal(JSON.stringify(req).includes(user.pinHash), false);
  assert.deepEqual(service.consume(req, user, "manager"), { usable: true, pinValid: true });
  assert.deepEqual(service.consume(req, user, "manager"), { usable: false, reason: "missing" });
  assert.equal(events.some((entry) => entry.label === "pinVerify"), true);
  assert.equal(events.some((entry) => entry.label === "consume.validPin"), true);
});

test("la prova conserva anche un PIN errato senza trasformarlo in autorizzazione", async () => {
  const { user, service } = createHarness({ pinValid: false });
  const req = createRequest();

  await service.prepare(req, APPROVE_PATH);
  assert.deepEqual(service.consume(req, user, "manager"), { usable: true, pinValid: false });
});

test("cambio concorrente di identita, hash o ruolo invalida la prova", async () => {
  for (const [expectedReason, changedUser] of [
    ["identity", createUser({ id: "u_manager_recreated" })],
    ["pin_hash", createUser({ pinHash: "pin-hash-v2" })],
    ["role", createUser({ role: "operator" })],
  ]) {
    const { service } = createHarness();
    const req = createRequest();
    await service.prepare(req, APPROVE_PATH);
    assert.deepEqual(service.consume(req, changedUser, "manager"), {
      usable: false,
      reason: expectedReason,
    });
  }
});

test("una prova non sopravvive alla ricreazione del servizio", async () => {
  const first = createHarness();
  const req = createRequest();
  await first.service.prepare(req, APPROVE_PATH);

  const restarted = createHarness();
  assert.deepEqual(restarted.service.consume(req, restarted.user, "manager"), {
    usable: false,
    reason: "missing",
  });
  first.service.discard(req);
});

test("flag disattivato non legge il DB e lascia il percorso canonico", async () => {
  let reads = 0;
  const service = createRoomChangeApprovePinProofService({
    enabled: false,
    readDb: async () => { reads += 1; return { users: [] }; },
    verifyPinAsync: async () => true,
  });
  const req = createRequest();

  assert.equal(service.shouldPrepare(req, APPROVE_PATH), false);
  assert.deepEqual(await service.prepare(req, APPROVE_PATH), {
    prepared: false,
    reason: "disabled_or_path",
  });
  assert.deepEqual(service.consume(req, createUser(), "manager"), {
    usable: false,
    reason: "disabled",
  });
  assert.equal(reads, 0);
});
