import { describe, expect, it } from "vitest";
import { buildNotificationStreamUrl } from "../src/api/notifications";

describe("notification stream scope", () => {
  it("propaga identita dispositivo e sala al filtro realtime backend", () => {
    const streamUrl = new URL(
      buildNotificationStreamUrl({
        userId: "waiter_7",
        username: "lorenzo",
        deviceUuid: "phone_3",
        roomId: "room_bar",
        roomName: "Bar",
      }),
      window.location.origin,
    );

    expect(streamUrl.pathname).toBe("/api/integration/notifications/stream");
    expect(streamUrl.searchParams.get("userId")).toBe("waiter_7");
    expect(streamUrl.searchParams.get("deviceUuid")).toBe("phone_3");
    expect(streamUrl.searchParams.get("roomId")).toBe("room_bar");
    expect(streamUrl.searchParams.get("roomName")).toBe("Bar");
  });
});
