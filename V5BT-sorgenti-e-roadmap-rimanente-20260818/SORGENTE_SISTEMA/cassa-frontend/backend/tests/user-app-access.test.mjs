import assert from "node:assert/strict";
import test from "node:test";

import {
  USER_APP_IDS,
  assertUserSessionAppAllowed,
  isUserAppEnabled,
  resolveUserAppIdFromClientApp,
  sanitizeUserEnabledAppIds,
} from "../auth/user-app-access.js";

test("legacy users retain access to all three applications", () => {
  assert.deepEqual(sanitizeUserEnabledAppIds(undefined), USER_APP_IDS);
  assert.equal(isUserAppEnabled({}, "cassa-frontend"), true);
  assert.equal(isUserAppEnabled({}, "postazione"), true);
  assert.equal(isUserAppEnabled({}, "mobile-frontend"), true);
});

test("an explicit app list is normalized, ordered and fail closed", () => {
  assert.deepEqual(
    sanitizeUserEnabledAppIds(["mobile-frontend", "cassa", "PALMARE", "invalid"]),
    ["cassa", "palmare"],
  );
  assert.deepEqual(sanitizeUserEnabledAppIds([]), []);
  assert.equal(isUserAppEnabled({ enabledAppIds: [] }, "postazione"), false);
});

test("client applications map to the three user-facing functions", () => {
  assert.equal(resolveUserAppIdFromClientApp("cassa-frontend"), "cassa");
  assert.equal(resolveUserAppIdFromClientApp("postazione"), "postazione");
  assert.equal(resolveUserAppIdFromClientApp("mobile-frontend"), "palmare");
  assert.equal(resolveUserAppIdFromClientApp("settings-frontend"), "");
  assert.equal(resolveUserAppIdFromClientApp("monitor-frontend"), "");
  assert.equal(resolveUserAppIdFromClientApp("unknown-client"), "");
});

test("settings and monitor remain outside production app scopes", () => {
  const user = { enabledAppIds: [] };
  assert.equal(isUserAppEnabled(user, "settings-frontend"), true);
  assert.equal(isUserAppEnabled(user, "monitor-frontend"), true);
  assert.equal(isUserAppEnabled(user, "unknown-client"), false);
});

test("a user can be enabled independently for each application", () => {
  const user = { enabledAppIds: ["postazione"] };
  assert.equal(isUserAppEnabled(user, "cassa-frontend"), false);
  assert.equal(isUserAppEnabled(user, "postazione"), true);
  assert.equal(isUserAppEnabled(user, "mobile-frontend"), false);
});

test("business client families inherit the correct production app scope", () => {
  assert.equal(resolveUserAppIdFromClientApp("mobile-table-move"), "palmare");
  assert.equal(resolveUserAppIdFromClientApp("mobile-automatic-cash"), "palmare");
  assert.equal(resolveUserAppIdFromClientApp("postazione-auto-print"), "postazione");
  assert.equal(resolveUserAppIdFromClientApp("cassa-unlock"), "cassa");

  assert.throws(
    () =>
      assertUserSessionAppAllowed(
        { enabledAppIds: ["cassa", "palmare"] },
        "cassa-frontend",
        "mobile-table-move",
      ),
    (error) =>
      error?.status === 401 && error?.code === "SESSION_CLIENT_APP_MISMATCH",
  );
  assert.doesNotThrow(() =>
    assertUserSessionAppAllowed(
      { enabledAppIds: ["postazione"] },
      "postazione",
      "postazione-auto-print",
    ),
  );
});

test("Android background radio is a companion only for Palmare and Postazione", () => {
  for (const sessionClientApp of ["mobile-frontend", "postazione"]) {
    assert.doesNotThrow(() =>
      assertUserSessionAppAllowed(
        { enabledAppIds: ["palmare", "postazione"] },
        sessionClientApp,
        "android-background-radio",
      ),
    );
  }
  for (const sessionClientApp of [
    "cassa-frontend",
    "settings-frontend",
    "monitor-frontend",
  ]) {
    assert.throws(
      () =>
        assertUserSessionAppAllowed(
          { enabledAppIds: USER_APP_IDS },
          sessionClientApp,
          "android-background-radio",
        ),
      (error) =>
        error?.status === 401 && error?.code === "SESSION_CLIENT_APP_MISMATCH",
    );
  }
});
