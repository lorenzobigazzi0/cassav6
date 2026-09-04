import assert from "node:assert/strict";
import test from "node:test";

import {
  clearNativeNotificationSession,
  updateNativeNotificationSession,
} from "../src/nativeNotificationSession.js";

test("logout clears the native session immediately", () => {
  let calls = 0;
  const scope = {
    AmaliaNativeNotifications: {
      clearSession() {
        calls += 1;
        return true;
      },
    },
  };

  assert.equal(clearNativeNotificationSession(scope), true);
  assert.equal(calls, 1);
});

test("login sends the complete session contract to the native runtime", () => {
  let received = null;
  const scope = {
    AmaliaNativeNotifications: {
      updateSession(payloadJson) {
        received = JSON.parse(payloadJson);
        return true;
      },
    },
  };
  const session = {
    token: "token-1",
    userId: "user-1",
    username: "mario",
    fullName: "Mario Rossi",
    deviceUuid: "device-1",
    roomId: "",
    roomName: "BAR-1",
  };

  assert.equal(updateNativeNotificationSession(session, scope), true);
  assert.deepEqual(received, session);
});

test("web-only mode and native bridge errors fail without breaking logout", () => {
  assert.equal(clearNativeNotificationSession({}), false);
  assert.equal(updateNativeNotificationSession({}, {}), false);
  assert.equal(
    clearNativeNotificationSession({
      AmaliaNativeNotifications: {
        clearSession() {},
      },
    }),
    false
  );
  assert.equal(
    updateNativeNotificationSession(
      {},
      {
        AmaliaNativeNotifications: {
          updateSession() {},
        },
      }
    ),
    false
  );
  assert.equal(
    clearNativeNotificationSession({
      AmaliaNativeNotifications: {
        clearSession() {
          throw new Error("bridge unavailable");
        },
      },
    }),
    false
  );
});
