import assert from "node:assert/strict";
import test from "node:test";

import { resolveReportsAuthContext } from "../modules/reports/reports.handlers.js";

test("reports riusa il contesto autenticato dal middleware anche con snapshot locale stale", () => {
  const expected = {
    user: { id: "user_1", username: "operatore" },
    session: { id: "session_1", deviceUuid: "device_1" },
  };
  let fallbackCalls = 0;

  const result = resolveReportsAuthContext(
    { __authContext: expected },
    { sessions: [] },
    { token: "stale-token", deviceUuid: "device_1" },
    () => {
      fallbackCalls += 1;
      throw new Error("la snapshot locale non deve rivalidare la sessione");
    },
  );

  assert.equal(result, expected);
  assert.equal(fallbackCalls, 0);
});

test("reports mantiene la validazione locale quando manca il contesto middleware", () => {
  const expected = {
    user: { id: "user_2", username: "admin" },
    session: { id: "session_2", deviceUuid: "device_2" },
  };
  const db = { sessions: [expected.session] };
  const payload = { token: "token", deviceUuid: "device_2" };
  let fallbackCalls = 0;

  const result = resolveReportsAuthContext({}, db, payload, (receivedDb, receivedPayload) => {
    fallbackCalls += 1;
    assert.equal(receivedDb, db);
    assert.equal(receivedPayload, payload);
    return expected;
  });

  assert.equal(result, expected);
  assert.equal(fallbackCalls, 1);
});
