import assert from "node:assert/strict";
import test from "node:test";

import {
  canStartPostazioneLogin,
  isCurrentPostazioneSession,
  performPostazioneLogout,
} from "../src/logoutSession.js";

test("local and native logout happen before the remote request", async () => {
  const calls = [];
  let releaseRemote;
  const remoteDone = new Promise((resolve) => {
    releaseRemote = resolve;
  });

  const pending = performPostazioneLogout({
    authSnapshot: { token: "token-1" },
    station: "BAR-1",
    reason: "",
    sessionInvalid: false,
    completeLocalLogout: () => calls.push("local"),
    requestBackendLogout: async () => {
      calls.push("remote");
      await remoteDone;
      return { ok: true };
    },
    requestStationOffline: async () => calls.push("offline"),
  });

  assert.deepEqual(calls, ["local", "remote"]);
  releaseRemote();
  await pending;
});

test("remote failure cannot keep or restore the local session", async () => {
  const calls = [];
  const result = await performPostazioneLogout({
    authSnapshot: { token: "token-1" },
    station: "BAR-1",
    reason: "rete assente",
    sessionInvalid: false,
    completeLocalLogout: (reason) => calls.push(`local:${reason}`),
    requestBackendLogout: async () => ({ ok: false }),
    requestStationOffline: async () => calls.push("offline"),
    onBackendUnavailable: () => calls.push("warning"),
  });

  assert.deepEqual(calls, ["local:rete assente", "warning"]);
  assert.equal(result.ok, false);
});

test("invalid server session still clears locally before station cleanup", async () => {
  const calls = [];
  await performPostazioneLogout({
    authSnapshot: { token: "token-1" },
    station: "BAR-1",
    reason: "sessione terminata",
    sessionInvalid: true,
    completeLocalLogout: () => calls.push("local"),
    requestBackendLogout: async () => {
      throw new Error("must not be called");
    },
    requestStationOffline: async () => calls.push("offline"),
  });

  assert.deepEqual(calls, ["local", "offline"]);
});

test("a deferred notification response is rejected after logout", async () => {
  let currentGeneration = 4;
  let auth = {
    loggedIn: true,
    token: "token-1",
    userId: "user-1",
    deviceUuid: "device-1",
  };
  let releaseResponse;
  const response = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const capturedGeneration = currentGeneration;

  const handled = (async () => {
    await response;
    return isCurrentPostazioneSession(
      capturedGeneration,
      currentGeneration,
      auth
    );
  })();

  currentGeneration += 1;
  auth = { ...auth, loggedIn: false, token: "" };
  releaseResponse();

  assert.equal(await handled, false);
});

test("a new login stays blocked while remote logout cleanup is pending", () => {
  assert.equal(canStartPostazioneLogin(true), false);
  assert.equal(canStartPostazioneLogin(false), true);
});
