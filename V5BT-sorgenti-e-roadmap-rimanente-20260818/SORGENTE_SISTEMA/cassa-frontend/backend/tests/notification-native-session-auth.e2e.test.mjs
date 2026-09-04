import assert from "node:assert/strict";
import test from "node:test";

import {
  apiPost,
  authPayload,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

function notificationUrl(baseUrl, endpoint, session, deviceUuid, overrides = {}) {
  const params = new URLSearchParams({
    consumer: `native-auth-${endpoint}`,
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    deviceUuid,
    ...overrides,
  });
  return `${baseUrl}/api/integration/notifications/${endpoint}?${params}`;
}

function nativeHeaders(session, deviceUuid, overrides = {}) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Username": session.user.username,
    "X-Device-Uuid": deviceUuid,
    "X-Session-Started-At": String(session.sessionStartedAt),
    ...overrides,
  };
}

async function closeResponse(response) {
  await response.body?.cancel().catch(() => undefined);
}

async function assertRejected(url, headers, label = "native request") {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 401, label);
  const body = await response.json();
  assert.equal(body.ok, false, label);
  assert.equal(body.code, "NOTIFICATION_NATIVE_SESSION_INVALID", label);
}

function postazioneNotificationUrl(baseUrl, session, deviceUuid, overrides = {}) {
  const params = new URLSearchParams({
    consumer: "postazione-auth-pull",
    ackConsumer: "postazione-auth-pull",
    clientApp: "postazione",
    station: "BAR-1",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid,
    ...overrides,
  });
  return `${baseUrl}/api/integration/notifications/pull?${params}`;
}

function postazioneHeaders(session, deviceUuid, overrides = {}) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Device-Uuid": deviceUuid,
    "X-Client-App": "postazione",
    ...overrides,
  };
}

async function assertPostazioneRejected(url, headers, label) {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 401, label);
  const body = await response.json();
  assert.equal(body.ok, false, label);
  assert.equal(
    body.code,
    "NOTIFICATION_POSTAZIONE_SESSION_INVALID",
    label,
  );
}

test("pull e stream vincolano gli header nativi alla sessione canonica", async (t) => {
  const { baseUrl } = await startBackend(t);
  const deviceUuid = "native-notification-auth-device";
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  assert.equal(Number.isSafeInteger(session.sessionStartedAt), true);

  const validHeaders = nativeHeaders(session, deviceUuid);
  const pullUrl = notificationUrl(baseUrl, "pull", session, deviceUuid);
  const streamUrl = notificationUrl(baseUrl, "stream", session, deviceUuid);

  const validPull = await fetch(pullUrl, { headers: validHeaders });
  assert.equal(validPull.status, 200);
  assert.equal((await validPull.json()).ok, true);

  const validStream = await fetch(streamUrl, { headers: validHeaders });
  assert.equal(validStream.status, 200);
  await closeResponse(validStream);

  const headersWithoutOptionalUsername = { ...validHeaders };
  delete headersWithoutOptionalUsername["X-Username"];
  const optionalUsernamePull = await fetch(pullUrl, {
    headers: headersWithoutOptionalUsername,
  });
  assert.equal(optionalUsernamePull.status, 200);
  await optionalUsernamePull.json();

  const invalidCases = [
    {
      name: "token",
      headers: nativeHeaders(session, deviceUuid, {
        Authorization: "Bearer session-token-errato",
      }),
    },
    {
      name: "epoch",
      headers: nativeHeaders(session, deviceUuid, {
        "X-Session-Started-At": String(session.sessionStartedAt + 1),
      }),
    },
    {
      name: "user",
      headers: nativeHeaders(session, deviceUuid, {
        "X-User-Id": "u_cashier",
      }),
    },
    {
      name: "username",
      headers: nativeHeaders(session, deviceUuid, {
        "X-Username": "cashier",
      }),
    },
    {
      name: "device",
      headers: nativeHeaders(session, deviceUuid, {
        "X-Device-Uuid": "native-notification-other-device",
      }),
    },
    {
      name: "partial",
      headers: (() => {
        const headers = nativeHeaders(session, deviceUuid);
        delete headers["X-Session-Started-At"];
        return headers;
      })(),
    },
    {
      name: "bearer-only",
      headers: { Authorization: `Bearer ${session.token}` },
    },
    {
      name: "missing-bearer",
      headers: (() => {
        const headers = nativeHeaders(session, deviceUuid);
        delete headers.Authorization;
        return headers;
      })(),
    },
    {
      name: "contradictory-client",
      headers: nativeHeaders(session, deviceUuid, {
        "X-Client-App": "postazione",
      }),
    },
  ];

  for (const invalidCase of invalidCases) {
    await assertRejected(pullUrl, invalidCase.headers, `${invalidCase.name} pull`);
    await assertRejected(
      streamUrl,
      invalidCase.headers,
      `${invalidCase.name} stream`,
    );
  }

  await assertRejected(
    notificationUrl(baseUrl, "pull", session, deviceUuid, {
      deviceUuid: "query-device-errato",
    }),
    validHeaders,
  );
  await assertRejected(
    notificationUrl(baseUrl, "stream", session, deviceUuid, {
      userId: "u_cashier",
    }),
    validHeaders,
  );
  await assertRejected(
    notificationUrl(baseUrl, "pull", session, deviceUuid, {
      clientApp: "",
    }),
    validHeaders,
    "clientApp parziale",
  );

  await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  await assertRejected(
    pullUrl,
    validHeaders,
    "sessione sostituita non canonica",
  );
});

test("query browser legacy senza header resta compatibile", async (t) => {
  const { baseUrl } = await startBackend(t);
  const deviceUuid = "legacy-notification-browser-device";
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const pullResponse = await fetch(
    notificationUrl(baseUrl, "pull", session, deviceUuid),
  );
  assert.equal(pullResponse.status, 200);
  assert.equal((await pullResponse.json()).ok, true);

  const streamResponse = await fetch(
    notificationUrl(baseUrl, "stream", session, deviceUuid),
  );
  assert.equal(streamResponse.status, 200);
  await closeResponse(streamResponse);
});

test("pull Postazione accetta solo la sessione autenticata e associata alla postazione", async (t) => {
  const { baseUrl } = await startBackend(t);
  const deviceUuid = "postazione-notification-auth-device";
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "postazione",
  });
  const pullUrl = postazioneNotificationUrl(baseUrl, session, deviceUuid);
  const headers = postazioneHeaders(session, deviceUuid);
  await assertPostazioneRejected(
    pullUrl,
    headers,
    "selezione postazione mancante",
  );

  const selected = await apiPost(
    baseUrl,
    "/api/auth/workstation/select",
    authPayload(session, deviceUuid, {
      clientApp: "postazione",
      workstationId: "workstation_bar_1",
      stationName: "BAR-1",
    }),
  );
  assert.equal(selected.response.status, 200);

  const validPull = await fetch(pullUrl, { headers });
  assert.equal(validPull.status, 200);
  assert.equal((await validPull.json()).ok, true);

  await assertPostazioneRejected(
    pullUrl,
    postazioneHeaders(session, deviceUuid, {
      Authorization: "Bearer session-token-errato",
    }),
    "token errato",
  );
  await assertPostazioneRejected(
    pullUrl,
    postazioneHeaders(session, deviceUuid, {
      "X-Session-Started-At": String(session.sessionStartedAt + 1),
    }),
    "epoch nativo non ammesso sul protocollo Postazione",
  );
  await assertPostazioneRejected(
    postazioneNotificationUrl(baseUrl, session, deviceUuid, {
      station: "BAR-2",
    }),
    headers,
    "postazione diversa dal binding della sessione",
  );

  const partialHeaders = { ...headers };
  delete partialHeaders["X-Device-Uuid"];
  await assertPostazioneRejected(
    pullUrl,
    partialHeaders,
    "header Postazione parziali",
  );

  const mismatchedClient = await fetch(pullUrl, {
    headers: postazioneHeaders(session, deviceUuid, {
      "X-Client-App": "mobile-frontend",
    }),
  });
  assert.equal(mismatchedClient.status, 401);
  assert.equal(
    (await mismatchedClient.json()).code,
    "NOTIFICATION_NATIVE_SESSION_INVALID",
  );
});
