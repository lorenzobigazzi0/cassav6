import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost,
  authHeaders,
  authPayload,
  login,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

test("[BE][P0] login con PIN valido restituisce sessione, ruolo e permessi", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);

  const response = await login(baseUrl, "cashier", "2222", {
    deviceUuid: "cashier-device-a",
    clientApp: "cassa-frontend",
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 20);
  assert.equal(typeof body.sessionStartedAt, "number");
  assert.ok(body.sessionStartedAt > 0);
  assert.equal(body.user.id, "u_cashier");
  assert.equal(body.user.username, "cashier");
  assert.equal(body.user.role, "operator");
  assert.ok(body.user.permissions.includes("collect_payments"));
  assert.equal(body.user.permissions.includes("manage_users"), false);

  const persisted = await readJson(dbPath);
  const session = persisted.sessions.find((entry) => entry.userId === "u_cashier");
  assert.equal(session?.deviceUuid, "cashier-device-a");
  assert.equal(session?.clientApp, "cassa-frontend");
  assert.equal(body.sessionStartedAt, new Date(session.createdAt).getTime());
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "auth.login_success"));
});

test("[BE][P0] enabledAppIds limita separatamente Cassa, Postazione e Palmare", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides: (state) => {
      const cashier = state.users.find((entry) => entry.id === "u_cashier");
      cashier.enabledAppIds = ["palmare"];
    },
  });

  for (const [clientApp, deviceUuid] of [
    ["cassa-frontend", "scope-denied-cassa"],
    ["postazione", "scope-denied-postazione"],
  ]) {
    const denied = await apiPost(baseUrl, "/api/auth/login", {
      username: "cashier",
      pin: "2222",
      deviceUuid,
      clientApp,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, "USER_APP_NOT_ALLOWED");
  }

  const palmare = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "scope-allowed-palmare",
    clientApp: "mobile-frontend",
  });
  assert.equal(palmare.response.status, 200);
  assert.deepEqual(palmare.body.user.enabledAppIds, ["palmare"]);

  const settings = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "scope-unscoped-settings",
    clientApp: "settings-frontend",
  });
  assert.equal(settings.response.status, 200);

  const persisted = await readJson(dbPath);
  assert.deepEqual(
    persisted.sessions.map((entry) => entry.deviceUuid).sort(),
    ["scope-allowed-palmare", "scope-unscoped-settings"],
  );
});

test("[BE][P0] una sessione Impostazioni non aggira lo scope Cassa", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides: (state) => {
      const cashier = state.users.find((entry) => entry.id === "u_cashier");
      cashier.enabledAppIds = [];
    },
  });
  const settings = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "settings-scope-boundary",
    clientApp: "settings-frontend",
  });

  const legacyStatus = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(settings, "settings-scope-boundary"),
  );
  assert.equal(legacyStatus.response.status, 200);

  const denied = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(settings, "settings-scope-boundary", {
      clientApp: "cassa-frontend",
    }),
  );
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.code, "USER_APP_NOT_ALLOWED");
});

test("[BE][P0] un token Cassa e un token Palmare non sono intercambiabili", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cassa = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "scope-bound-cassa",
    clientApp: "cassa-frontend",
  });
  const palmare = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "scope-bound-palmare",
    clientApp: "mobile-frontend",
  });

  for (const [session, deviceUuid, clientApp] of [
    [cassa, "scope-bound-cassa", "mobile-frontend"],
    [palmare, "scope-bound-palmare", "cassa-frontend"],
  ]) {
    const denied = await apiPost(
      baseUrl,
      "/api/auth/session/status",
      authPayload(session, deviceUuid, { clientApp }),
    );
    assert.equal(denied.response.status, 401);
    assert.equal(denied.body.code, "SESSION_CLIENT_APP_MISMATCH");
  }
});

test("[BE][P0] il companion radio Android accetta solo sessioni Palmare o Postazione", async (t) => {
  const { baseUrl } = await startBackend(t);
  const sessions = [
    [
      await loginJson(baseUrl, "cashier", "2222", {
        deviceUuid: "radio-companion-palmare",
        clientApp: "mobile-frontend",
      }),
      "radio-companion-palmare",
      200,
    ],
    [
      await loginJson(baseUrl, "manager", "4444", {
        deviceUuid: "radio-companion-postazione",
        clientApp: "postazione",
      }),
      "radio-companion-postazione",
      200,
    ],
    [
      await loginJson(baseUrl, "admin_test", "1111", {
        deviceUuid: "radio-companion-cassa",
        clientApp: "cassa-frontend",
      }),
      "radio-companion-cassa",
      401,
    ],
  ];

  for (const [session, deviceUuid, expectedStatus] of sessions) {
    const status = await apiPost(
      baseUrl,
      "/api/auth/session/status",
      authPayload(session, deviceUuid, {
        clientApp: "android-background-radio",
      }),
    );
    assert.equal(status.response.status, expectedStatus);
    if (expectedStatus === 401) {
      assert.equal(status.body.code, "SESSION_CLIENT_APP_MISMATCH");
    }
  }
});

test("[BE][P0] il salvataggio utenti revoca solo le sessioni delle funzioni disabilitate", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "scope-admin-settings",
    clientApp: "settings-frontend",
  });
  const cassa = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "scope-revoke-cassa",
    clientApp: "cassa-frontend",
  });
  const palmare = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "scope-retain-palmare",
    clientApp: "mobile-frontend",
  });

  const listed = await apiPost(
    baseUrl,
    "/api/settings/pos/users",
    authPayload(admin, "scope-admin-settings", {
      clientApp: "settings-frontend",
    }),
  );
  assert.equal(listed.response.status, 200);
  const users = listed.body.users.map((user) =>
    user.id === "u_cashier"
      ? { ...user, enabledAppIds: ["palmare"] }
      : user,
  );
  const saved = await apiPost(
    baseUrl,
    "/api/settings/pos/users/save",
    authPayload(admin, "scope-admin-settings", {
      clientApp: "settings-frontend",
      users,
      groups: listed.body.groups,
    }),
  );
  assert.equal(saved.response.status, 200);
  assert.deepEqual(
    saved.body.users.find((user) => user.id === "u_cashier")?.enabledAppIds,
    ["palmare"],
  );

  const revokedStatus = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(cassa, "scope-revoke-cassa", {
      clientApp: "cassa-frontend",
    }),
  );
  assert.equal(revokedStatus.response.status, 401);

  const retainedStatus = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(palmare, "scope-retain-palmare", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(retainedStatus.response.status, 200);

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.sessions.some(
      (entry) => entry.deviceUuid === "scope-revoke-cassa",
    ),
    false,
  );
  assert.equal(
    persisted.sessions.some(
      (entry) => entry.deviceUuid === "scope-retain-palmare",
    ),
    true,
  );
});

test("[BE][P1] login Postazione richiede una seconda scelta limitata alla allowlist utente", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides: (state) => {
      state.posSettings.workstations = [
        {
          id: "workstation_bar_1",
          name: "Bar principale",
          stationName: "BAR-1",
          active: true,
          status: "active",
        },
        {
          id: "workstation_kitchen",
          name: "Cucina",
          stationName: "CUCINA",
          active: true,
          status: "active",
        },
        {
          id: "workstation_disabled",
          name: "Disabilitata",
          stationName: "SPENTA",
          active: false,
          status: "disabled",
        },
      ];
      const cashier = state.users.find((entry) => entry.id === "u_cashier");
      cashier.workstationIds = ["workstation_kitchen"];
    },
  });

  const loginResult = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-two-step",
    clientApp: "postazione",
  });
  assert.equal(loginResult.response.status, 200);
  assert.equal(loginResult.body.workstationSelectionRequired, true);
  assert.deepEqual(loginResult.body.availableWorkstations, [
    {
      id: "workstation_kitchen",
      name: "Cucina",
      stationName: "CUCINA",
    },
  ]);

  let persisted = await readJson(dbPath);
  let persistedSession = persisted.sessions.find(
    (entry) => entry.deviceUuid === "station-two-step",
  );
  assert.equal(persistedSession?.workstationId, undefined);

  const denied = await apiPost(
    baseUrl,
    "/api/auth/workstation/select",
    authPayload(loginResult.body, "station-two-step", {
      clientApp: "postazione",
      workstationId: "workstation_bar_1",
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.code, "WORKSTATION_NOT_ALLOWED");

  const selected = await apiPost(
    baseUrl,
    "/api/auth/workstation/select",
    authPayload(loginResult.body, "station-two-step", {
      clientApp: "postazione",
      workstationId: "workstation_kitchen",
    }),
  );
  assert.equal(selected.response.status, 200);
  assert.equal(selected.body.workstationSelectionRequired, false);
  assert.deepEqual(selected.body.selectedWorkstation, {
    id: "workstation_kitchen",
    name: "Cucina",
    stationName: "CUCINA",
  });

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(loginResult.body, "station-two-step", {
      clientApp: "postazione",
    }),
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.workstationSelectionRequired, false);
  assert.equal(status.body.workstationId, "workstation_kitchen");
  assert.equal(status.body.stationName, "CUCINA");

  persisted = await readJson(dbPath);
  persistedSession = persisted.sessions.find(
    (entry) => entry.deviceUuid === "station-two-step",
  );
  assert.equal(persistedSession?.workstationId, "workstation_kitchen");
  assert.equal(persistedSession?.stationName, "CUCINA");
  assert.ok(
    persisted.auditEvents.some(
      (entry) => entry.action === "auth.workstation_selected",
    ),
  );
});

test("[BE][P1] utente senza postazioni abilitate resta autenticato ma non operativo", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides: (state) => {
      const cashier = state.users.find((entry) => entry.id === "u_cashier");
      cashier.workstationIds = [];
    },
  });
  const loginResult = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-no-access",
    clientApp: "postazione",
  });
  assert.equal(loginResult.response.status, 200);
  assert.equal(loginResult.body.workstationSelectionRequired, true);
  assert.deepEqual(loginResult.body.availableWorkstations, []);

  const heartbeat = await apiPost(
    baseUrl,
    "/api/integration/stations/state",
    authPayload(loginResult.body, "station-no-access", {
      clientApp: "postazione",
      station: "BAR-1",
      active: true,
    }),
  );
  assert.equal(heartbeat.response.status, 409);
  assert.equal(heartbeat.body.code, "WORKSTATION_SELECTION_REQUIRED");
});

test("[BE][P1] login Postazione legacy non puo associare una postazione fuori allowlist", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides: (state) => {
      state.posSettings.workstations = [
        {
          id: "workstation_bar_1",
          name: "Bar principale",
          stationName: "BAR-1",
          active: true,
          status: "active",
        },
        {
          id: "workstation_kitchen",
          name: "Cucina",
          stationName: "CUCINA",
          active: true,
          status: "active",
        },
      ];
      const cashier = state.users.find((entry) => entry.id === "u_cashier");
      cashier.workstationIds = ["workstation_kitchen"];
    },
  });

  const denied = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-legacy-denied",
    clientApp: "postazione",
    station: "BAR-1",
  });

  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.code, "WORKSTATION_NOT_ALLOWED");
  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.sessions.some(
      (entry) => entry.deviceUuid === "station-legacy-denied",
    ),
    false,
  );
  assert.equal(
    persisted.auditEvents.some(
      (entry) =>
        entry.action === "auth.login_success" &&
        entry.payload?.deviceUuid === "station-legacy-denied",
    ),
    false,
  );
});

test("[BE][P1] endpoint selezione rifiuta una postazione disabilitata", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides: (state) => {
      state.posSettings.workstations = [
        {
          id: "workstation_disabled",
          name: "Postazione disabilitata",
          stationName: "SPENTA",
          active: false,
          status: "disabled",
        },
      ];
      const cashier = state.users.find((entry) => entry.id === "u_cashier");
      cashier.workstationIds = ["workstation_disabled"];
    },
  });

  const loginResult = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-disabled-selection",
    clientApp: "postazione",
  });
  assert.equal(loginResult.response.status, 200);
  assert.deepEqual(loginResult.body.availableWorkstations, []);

  const denied = await apiPost(
    baseUrl,
    "/api/auth/workstation/select",
    authPayload(loginResult.body, "station-disabled-selection", {
      clientApp: "postazione",
      workstationId: "workstation_disabled",
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.code, "WORKSTATION_NOT_ALLOWED");
});

test("[BE][P1] selezioni concorrenti assegnano una postazione a un solo utente", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides: (state) => {
      state.posSettings.workstations = [
        {
          id: "workstation_bar_1",
          name: "Bar principale",
          stationName: "BAR-1",
          active: true,
          status: "active",
        },
      ];
      for (const userId of ["u_cashier", "u_manager"]) {
        const user = state.users.find((entry) => entry.id === userId);
        user.workstationIds = ["workstation_bar_1"];
      }
    },
  });

  const [cashierLogin, managerLogin] = await Promise.all([
    apiPost(baseUrl, "/api/auth/login", {
      username: "cashier",
      pin: "2222",
      deviceUuid: "station-race-cashier",
      clientApp: "postazione",
    }),
    apiPost(baseUrl, "/api/auth/login", {
      username: "manager",
      pin: "4444",
      deviceUuid: "station-race-manager",
      clientApp: "postazione",
    }),
  ]);
  assert.equal(cashierLogin.response.status, 200);
  assert.equal(managerLogin.response.status, 200);

  const selections = await Promise.all([
    apiPost(
      baseUrl,
      "/api/auth/workstation/select",
      authPayload(cashierLogin.body, "station-race-cashier", {
        clientApp: "postazione",
        workstationId: "workstation_bar_1",
      }),
    ),
    apiPost(
      baseUrl,
      "/api/auth/workstation/select",
      authPayload(managerLogin.body, "station-race-manager", {
        clientApp: "postazione",
        workstationId: "workstation_bar_1",
      }),
    ),
  ]);

  assert.deepEqual(
    selections.map((entry) => entry.response.status).sort((a, b) => a - b),
    [200, 409],
  );
  const conflict = selections.find((entry) => entry.response.status === 409);
  assert.equal(conflict?.body?.code, "WORKSTATION_ALREADY_IN_USE");

  const persisted = await readJson(dbPath);
  const assignedSessions = persisted.sessions.filter(
    (entry) => entry.workstationId === "workstation_bar_1",
  );
  assert.equal(assignedSessions.length, 1);
  assert.equal(
    persisted.auditEvents.filter(
      (entry) =>
        entry.action === "auth.workstation_selected" &&
        entry.payload?.workstationId === "workstation_bar_1",
    ).length,
    1,
  );
});

test("[BE][P1] due utenti diversi non possono coesistere sulla stessa postazione", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides: (state) => {
      state.posSettings.workstations = [
        {
          id: "workstation_bar_1",
          name: "BAR-1",
          stationName: "BAR-1",
          status: "active",
          enabled: true,
        },
      ];
    },
  });

  const first = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-device-a",
    clientApp: "postazione",
    station: "BAR-1",
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.ok, true);

  const second = await apiPost(baseUrl, "/api/auth/login", {
    username: "manager",
    pin: "4444",
    deviceUuid: "station-device-b",
    clientApp: "postazione",
    stationName: "BAR-1",
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.code, "WORKSTATION_ALREADY_IN_USE");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].userId, "u_cashier");
  assert.equal(persisted.sessions[0].workstationId, "workstation_bar_1");
  assert.equal(persisted.sessions[0].stationName, "BAR-1");
});

test("[BE][P1] session status postazione riallinea lo stato attivo della postazione", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides: (state) => {
      state.integration.stationStates = [];
      state.posSettings.workstations = [
        {
          id: "workstation_bar_1",
          name: "BAR-1",
          stationName: "BAR-1",
          status: "active",
          enabled: true,
        },
      ];
    },
  });

  const loginResult = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-device-heartbeat",
    clientApp: "postazione",
    station: "BAR-1",
  });
  assert.equal(loginResult.response.status, 200);
  const session = loginResult.body;
  const recoveredBeforeStatus = await fetch(`${baseUrl}/api/integration/stations/active`);
  const recoveredPayload = await recoveredBeforeStatus.json();
  assert.equal(recoveredPayload.stations.length, 1);
  assert.equal(recoveredPayload.stations[0].station, "BAR-1");

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "station-device-heartbeat", { clientApp: "postazione" })
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);

  const activeResponse = await fetch(`${baseUrl}/api/integration/stations/active`);
  const activePayload = await activeResponse.json();
  assert.equal(activePayload.stations.length, 1);
  assert.equal(activePayload.stations[0].station, "BAR-1");
  assert.equal(activePayload.stations[0].operatorUserId, "u_cashier");
  assert.equal(activePayload.stations[0].deviceUuid, "station-device-heartbeat");

  const persisted = await readJson(dbPath);
  const persistedStation = persisted.integration.stationStates.find(
    (entry) => entry.station === "BAR-1" && entry.realStation === true
  );
  assert.equal(persistedStation?.active, true);
  assert.equal(persistedStation?.realStation, true);
});

test("[BE][P1] le postazioni operative V5BT BAR-1 e BAR-2 risultano attive dopo login", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    timeoutMs: 30_000,
    stateOverrides: (state) => {
      state.integration.stationStates = [];
      state.posSettings.workstations = [
        {
          id: "workstation_bar_principale",
          name: "Bar principale",
          stationName: "BAR-1",
          status: "active",
          active: true,
          enabled: true,
        },
        {
          id: "workstation_cucina",
          name: "Cucina",
          stationName: "BAR-2",
          status: "active",
          active: true,
          enabled: true,
        },
      ];
    },
  });

  const barLogin = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "v5bt-bar-device",
    clientApp: "postazione",
    station: "BAR-1",
  });
  assert.equal(barLogin.response.status, 200);

  const kitchenLogin = await apiPost(baseUrl, "/api/auth/login", {
    username: "manager",
    pin: "4444",
    deviceUuid: "v5bt-kitchen-device",
    clientApp: "postazione",
    stationName: "BAR-2",
  });
  assert.equal(kitchenLogin.response.status, 200);

  for (const [session, deviceUuid] of [
    [barLogin.body, "v5bt-bar-device"],
    [kitchenLogin.body, "v5bt-kitchen-device"],
  ]) {
    const status = await apiPost(
      baseUrl,
      "/api/auth/session/status",
      authPayload(session, deviceUuid, { clientApp: "postazione" }),
    );
    assert.equal(status.response.status, 200);
    assert.equal(status.body.valid, true);
  }

  const activeResponse = await fetch(`${baseUrl}/api/integration/stations/active`);
  assert.equal(activeResponse.status, 200);
  const activePayload = await activeResponse.json();
  assert.deepEqual(
    activePayload.stations.map((entry) => entry.station).sort(),
    ["BAR-1", "BAR-2"],
  );

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.sessions.find((entry) => entry.deviceUuid === "v5bt-bar-device")
      ?.workstationId,
    "workstation_bar_principale",
  );
  assert.equal(
    persisted.sessions.find(
      (entry) => entry.deviceUuid === "v5bt-kitchen-device",
    )?.workstationId,
    "workstation_cucina",
  );
});

test("[BE][P0] login con PIN errato non crea sessione e non muta l'utente", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const before = await readJson(dbPath);
  const beforeUser = before.users.find((entry) => entry.id === "u_cashier");

  const response = await login(baseUrl, "cashier", "9999", {
    deviceUuid: "cashier-device-b",
    clientApp: "cassa-frontend",
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Credenziali non valide/);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.sessions.length, 0);
  const afterUser = persisted.users.find((entry) => entry.id === "u_cashier");
  assert.equal(afterUser.username, beforeUser.username);
  assert.equal(afterUser.pinHash, beforeUser.pinHash);
  assert.deepEqual(afterUser.permissions, beforeUser.permissions);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "auth.login_failed"));
});

test("[BE][P0] rate limit login blocca tentativi falliti ravvicinati", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "2",
      LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
    },
  });

  for (const expectedStatus of [401, 401, 429]) {
    const response = await login(baseUrl, "cashier", "9999", {
      deviceUuid: "rate-limit-device",
      clientApp: "cassa-frontend",
    });
    assert.equal(response.status, expectedStatus);
  }

  const persisted = await readJson(dbPath);
  assert.equal(persisted.sessions.length, 0);
  assert.equal(
    persisted.auditEvents.filter((entry) => entry.action === "auth.login_failed").length,
    2
  );
});

test("[BE][P0] logout invalida la sessione", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "logout-device",
    clientApp: "cassa-frontend",
  });

  const logout = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(session, "logout-device", { clientApp: "cassa-frontend" })
  );
  assert.equal(logout.response.status, 200);
  assert.equal(logout.body.loggedOut, true);

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "logout-device", { clientApp: "cassa-frontend" })
  );
  assert.equal(status.response.status, 401);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.sessions.some((entry) => entry.userId === "u_cashier"), false);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "auth.logout"));
});

test("[BE][P0] session status rinnova heartbeat e restituisce l'utente corretto", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: { SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "1" },
  });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "heartbeat-device",
    clientApp: "mobile-frontend",
  });
  const before = await readJson(dbPath);
  const beforeSession = before.sessions.find((entry) => entry.userId === "u_cashier");
  const beforeHeartbeat = String(beforeSession?.lastSeenAt ?? beforeSession?.updatedAt ?? "");

  await new Promise((resolve) => setTimeout(resolve, 5));
  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "heartbeat-device", { clientApp: "mobile-frontend" })
  );

  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);
  assert.equal(status.body.userId, "u_cashier");
  assert.equal(status.body.clientApp, "mobile-frontend");

  const persisted = await readJson(dbPath);
  const touched = persisted.sessions.find((entry) => entry.userId === "u_cashier");
  const afterHeartbeat = String(touched?.lastSeenAt ?? touched?.updatedAt ?? "");
  assert.notEqual(afterHeartbeat, beforeHeartbeat);
});

test("[BE][P1] session status ravvicinato aggiorna live senza riscrivere subito il DB", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: { SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "600000" },
  });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "heartbeat-live-device",
    clientApp: "mobile-frontend",
  });
  const before = await readJson(dbPath);
  const beforeSession = before.sessions.find((entry) => entry.userId === "u_cashier");
  const beforeHeartbeat = String(beforeSession?.lastSeenAt ?? "");

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "heartbeat-live-device", { clientApp: "mobile-frontend" })
  );

  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);

  const persisted = await readJson(dbPath);
  const persistedSession = persisted.sessions.find((entry) => entry.userId === "u_cashier");
  assert.equal(String(persistedSession?.lastSeenAt ?? ""), beforeHeartbeat);
});

test("[BE][P1] session status ravvicinato non entra nella coda mutativa", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
      SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "600000",
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "session-metrics-device",
    clientApp: "mobile-frontend",
  });

  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    authPayload(session, "session-metrics-device", { clientApp: "mobile-frontend" })
  );
  assert.equal(reset.response.status, 200);

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "session-metrics-device", { clientApp: "mobile-frontend" })
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, "session-metrics-device"),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.dbMutationEnqueued, 0);
});

test("[BE][P1] session status persistente usa lane presenza e non la coda globale", async (t) => {
  const deviceUuid = "session-persist-lane-device";
  const { baseUrl } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
      SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "1",
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" })
  );
  assert.equal(reset.response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" })
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.dbMutationEnqueued, 0);
  assert.equal(metrics.runtimeMetrics.counters.stationStateLaneEnqueued, 1);
});

test("[BE][P1] session status no-op riusa il DB validato dalla policy", async (t) => {
  const deviceUuid = "session-status-single-read-device";
  const { baseUrl } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
      SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "600000",
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" })
  );
  assert.equal(reset.response.status, 200);

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" })
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  const readMetric =
    metrics.runtimeMetrics.requests.readDbCountByRoute["POST /api/auth/session/status"];
  const writeMetric =
    metrics.runtimeMetrics.requests.writeDbCountByRoute["POST /api/auth/session/status"];
  assert.equal(readMetric.max, 1);
  assert.equal(readMetric.p99, 1);
  assert.equal(writeMetric.max, 0);
});

test("[BE][P1] session status postazione evita rewrite persistente su heartbeat ravvicinato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      INTEGRATION_STATION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "600000",
      SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "600000",
    },
    stateOverrides: (state) => {
      state.integration.stationStates = [];
      state.posSettings.workstations = [
        {
          id: "workstation_bar_1",
          name: "BAR-1",
          stationName: "BAR-1",
          status: "active",
          enabled: true,
        },
      ];
    },
  });
  const loginResult = await apiPost(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid: "station-live-device",
    clientApp: "postazione",
    station: "BAR-1",
  });
  assert.equal(loginResult.response.status, 200);
  const session = loginResult.body;

  const first = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "station-live-device", {
      clientApp: "postazione",
      station: "BAR-1",
    })
  );
  assert.equal(first.response.status, 200);

  const before = await readJson(dbPath);
  const beforeStation = before.integration.stationStates.find(
    (entry) => entry.station === "BAR-1" && entry.realStation === true
  );
  assert.equal(beforeStation?.active, true);
  const beforeUpdatedAtMs = Number(beforeStation?.updatedAtMs ?? 0);

  const second = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "station-live-device", {
      clientApp: "postazione",
      station: "BAR-1",
    })
  );
  assert.equal(second.response.status, 200);

  const persisted = await readJson(dbPath);
  const persistedStation = persisted.integration.stationStates.find(
    (entry) => entry.station === "BAR-1" && entry.realStation === true
  );
  assert.equal(Number(persistedStation?.updatedAtMs ?? 0), beforeUpdatedAtMs);
});

test("[BE][P0] token valido con deviceUuid diverso viene rifiutato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "bound-device",
    clientApp: "cassa-frontend",
  });

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "other-device", { clientApp: "cassa-frontend" })
  );

  assert.equal(status.response.status, 401);
  const persisted = await readJson(dbPath);
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].deviceUuid, "bound-device");
});

test("[BE][P0] permessi insufficienti bloccano route protette", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const viewer = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-device",
    clientApp: "cassa-frontend",
  });
  const payload = authPayload(viewer, "waiter-device", {});

  for (const [pathName, body] of [
    ["/api/payments/table", { tableId: "room_pedana_t05", paymentMethodId: "pay_cash" }],
    ["/api/settings/menu", { items: [] }],
    ["/api/settings/pos/users", {}],
    ["/api/settings/pos/general/save", { settings: {} }],
  ]) {
    const result = await apiPost(baseUrl, pathName, { ...payload, ...body });
    assert.equal(result.response.status, 403, pathName);
  }

  const persisted = await readJson(dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
  assert.ok(persisted.sessions.some((entry) => entry.userId === "u_waiter"));
});
