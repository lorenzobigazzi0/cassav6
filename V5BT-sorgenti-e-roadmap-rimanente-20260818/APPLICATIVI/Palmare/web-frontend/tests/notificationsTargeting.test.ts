import { afterEach, describe, expect, it, vi } from "vitest";
import { extractNotificationsFromStreamDetail, fetchNotifications } from "../src/api/notifications";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeNotification(id: string, meta: Record<string, unknown>) {
  return {
    id,
    type: "general",
    title: `Notifica ${id}`,
    description: "Test",
    createdAt: Date.now(),
    meta,
  };
}

describe("notifications — targeting squillo palmare", () => {
  it("distingue un backend irraggiungibile da una snapshot valida ma vuota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );

    await expect(fetchNotifications({ deviceUuid: "device-abc" })).rejects.toThrow(
      "notification-backend-unavailable"
    );
  });

  it("accetta squilli mirati per alias device normalizzato o IP gia filtrato dal backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                makeNotification("alias", {
                  eventType: "handheld_ring",
                  targetClientApp: "mobile-frontend",
                  targetDeviceIdAliases: [" DEVICE-ABC "],
                }),
                makeNotification("ip", {
                  eventType: "handheld_ring",
                  targetClientApp: "mobile-frontend",
                  targetClientIp: "192.168.1.77",
                }),
                makeNotification("other-device", {
                  eventType: "handheld_ring",
                  targetClientApp: "mobile-frontend",
                  targetDeviceIdAliases: ["device-xyz"],
                }),
                makeNotification("other-app", {
                  eventType: "handheld_ring",
                  targetClientApp: "postazione",
                  targetDeviceIdAliases: ["DEVICE-ABC"],
                }),
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const items = await fetchNotifications({ deviceUuid: "device-abc" });
    expect(items.map((item) => item.id)).toEqual(["alias", "ip"]);
  });
});

describe("notifications — targeting comanda pronta", () => {
  it("accetta la notifica se combacia una identita utente anche con userId diverso", async () => {
    const readyNotification = makeNotification("ready", {
      eventType: "order_ready",
      targetClientApp: "mobile-frontend",
      targetUserId: "u_old_session",
      targetUsername: "giada",
      targetFullName: "Giada Sala",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                readyNotification,
                makeNotification("other", {
                  eventType: "order_ready",
                  targetClientApp: "mobile-frontend",
                  targetUserId: "u_other",
                  targetUsername: "lorenzo",
                  targetFullName: "Lorenzo Banco",
                }),
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const context = {
      userId: "u_new_session",
      username: "giada",
      fullName: "Giada Sala",
    };
    const pulled = await fetchNotifications(context);
    const streamed = extractNotificationsFromStreamDetail(
      { notification: readyNotification },
      context
    );

    expect(pulled.map((item) => item.id)).toEqual(["ready"]);
    expect(streamed.map((item) => item.id)).toEqual(["ready"]);
  });

  it("accetta la notifica fallback online anche se il target originale non combacia", async () => {
    const fallbackNotification = makeNotification("ready-fallback", {
      eventType: "order_ready",
      targetClientApp: "mobile-frontend",
      targetUserId: "u_offline",
      targetUsername: "waiter_offline",
      targetFullName: "Waiter Offline",
      targetFallbackActive: true,
      targetFallbackScope: "online_mobile",
    });

    const streamed = extractNotificationsFromStreamDetail(
      { notification: fallbackNotification },
      {
        userId: "u_online",
        username: "waiter_online",
        fullName: "Waiter Online",
        deviceUuid: "device-online",
      }
    );

    expect(streamed.map((item) => item.id)).toEqual(["ready-fallback"]);
  });

  it("rispetta la lista dei camerieri di rerouting e le esclusioni", () => {
    const context = {
      userId: "u_same_room",
      username: "waiter_same_room",
      roomId: "room_gazebo",
      roomName: "Gazebo",
      deviceUuid: "device-online",
    };
    const streamed = extractNotificationsFromStreamDetail(
      {
        notifications: [
          makeNotification("eligible", {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetUserId: "u_offline_original",
            targetUserIds: ["u_same_room", "u_other_room"],
            excludeUserIds: ["u_offline_original"],
            targetRoomId: "room_gazebo",
            targetFallbackActive: true,
            targetFallbackScope: "online_mobile",
          }),
          makeNotification("not-in-list", {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetUserIds: ["u_other_room"],
            targetFallbackActive: true,
          }),
          makeNotification("explicitly-excluded", {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetUserIds: ["u_same_room"],
            excludedUserIds: ["u_same_room"],
            targetFallbackActive: true,
          }),
        ],
      },
      context
    );

    expect(streamed.map((item) => item.id)).toEqual(["eligible"]);
  });

  it("filtra la sala e non tratta targetClientApp come unico target di rerouting", () => {
    const context = {
      userId: "u_online",
      username: "waiter_online",
      roomId: "room_gazebo",
      roomName: "Gazebo",
      deviceUuid: "device-online",
    };
    const streamed = extractNotificationsFromStreamDetail(
      {
        notifications: [
          makeNotification("same-room-by-object", {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            room: { id: "room_gazebo", name: "Gazebo" },
            targetFallbackActive: true,
          }),
          makeNotification("other-room", {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetRoomId: "room_pedana",
            targetFallbackActive: true,
          }),
          makeNotification("app-only-reroute", {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetFallbackActive: true,
            targetFallbackScope: "online_mobile",
          }),
        ],
      },
      context
    );

    expect(streamed.map((item) => item.id)).toEqual(["same-room-by-object"]);
  });
});

describe("notifications - logout postazione realtime", () => {
  it("estrae subito tutte le notifiche incluse nell'evento SSE di logout", () => {
    const streamed = extractNotificationsFromStreamDetail(
      {
        notifications: [
          makeNotification("station-offline", {
            eventType: "station_offline",
            targetClientApp: "mobile-frontend",
          }),
          makeNotification("no-active-stations", {
            eventType: "no_active_stations",
            targetClientApp: "mobile-frontend",
          }),
        ],
      },
      { deviceUuid: "waiter-device" }
    );

    expect(streamed.map((item) => item.id)).toEqual(["station-offline", "no-active-stations"]);
  });
});
