import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endCurrentSession } from "../src/app/session/endSession";
import {
  clearNativeNotificationSession,
  syncNativeNotificationSession,
} from "../src/shared/native/nativeNotificationSession";
import { useAuthStore } from "../src/store/authStore";
import { parseBackendLoginResponse } from "../src/api/auth";

const authenticatedState = {
  token: "token-session",
  userId: "user-7",
  username: "mario",
  fullName: "Mario Rossi",
  sessionStartedAt: 1_000,
  deviceUuid: "device-7",
  roomId: "room-gazebo",
  roomName: "Gazebo",
  activityId: "activity-default",
  activityName: "Servizio",
};

describe("mobile session logout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.AmaliaNativeNotifications;
    useAuthStore.setState(authenticatedState);
  });

  afterEach(() => {
    delete window.AmaliaNativeNotifications;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sincronizza il contratto camelCase definitivo con AmaliaNativeNotifications", () => {
    const updateSessionContext = vi.fn(() => true);
    const clearSession = vi.fn(() => true);
    window.AmaliaNativeNotifications = { updateSessionContext, clearSession };

    expect(
      syncNativeNotificationSession({
        token: " token-session ",
        userId: " user-7 ",
        username: " mario ",
        fullName: " Mario Rossi ",
        deviceUuid: " device-7 ",
        sessionStartedAt: 1_718_000_000_123,
        roomId: " room-gazebo ",
        roomName: " Gazebo ",
      })
    ).toBe(true);

    expect(JSON.parse(updateSessionContext.mock.calls[0][0])).toEqual({
      token: "token-session",
      userId: "user-7",
      username: "mario",
      fullName: "Mario Rossi",
      deviceUuid: "device-7",
      sessionStartedAt: 1_718_000_000_123,
      roomId: "room-gazebo",
      roomName: "Gazebo",
      clientApp: "mobile-frontend",
    });
    expect(clearSession).not.toHaveBeenCalled();
    expect(clearNativeNotificationSession()).toBe(true);
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("usa clearSession fail-closed quando il contesto nativo e incompleto", () => {
    const updateSessionContext = vi.fn(() => true);
    const clearSession = vi.fn(() => true);
    window.AmaliaNativeNotifications = { updateSessionContext, clearSession };

    expect(
      syncNativeNotificationSession({
        token: "",
        userId: "user-7",
        username: "mario",
        fullName: "Mario Rossi",
        deviceUuid: "device-7",
        sessionStartedAt: 1_718_000_000_123,
        roomId: "",
        roomName: "",
      })
    ).toBe(false);
    expect(updateSessionContext).not.toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("conserva esattamente l'epoca server nello store, storage e bridge nativo", () => {
    const updateSessionContext = vi.fn(() => true);
    window.AmaliaNativeNotifications = {
      updateSessionContext,
      clearSession: vi.fn(() => true),
    };
    vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);

    useAuthStore.getState().setAuth({
      token: "server-token",
      deviceUuid: "device-7",
      sessionStartedAt: 1_718_000_000_123,
      user: {
        id: "user-7",
        username: "mario",
        fullName: "Mario Rossi",
        role: "operator",
        roleLabel: "Operatore",
        permissions: [],
      },
    });

    expect(useAuthStore.getState().sessionStartedAt).toBe(1_718_000_000_123);
    expect(window.localStorage.getItem("pos_auth_session_started_at")).toBe("1718000000123");
    expect(window.localStorage.getItem("pos_session_started_at")).toBeNull();
    expect(JSON.parse(updateSessionContext.mock.calls.at(-1)?.[0] ?? "{}")).toMatchObject({
      sessionStartedAt: 1_718_000_000_123,
    });
  });

  it("usa l'epoca server e limita il fallback locale alle risposte legacy", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    const base = {
      ok: true,
      token: "server-token",
      user: { id: "user-7", username: "mario", fullName: "Mario Rossi" },
    };

    expect(
      parseBackendLoginResponse({ ...base, sessionStartedAt: 1_718_000_000_123 })
    ).toMatchObject({ ok: true, sessionStartedAt: 1_718_000_000_123 });
    expect(parseBackendLoginResponse(base)).toMatchObject({
      ok: true,
      sessionStartedAt: 1_900_000_000_000,
    });
    expect(parseBackendLoginResponse({ ...base, sessionStartedAt: "invalid" })).toEqual({
      ok: false,
      error: "Risposta backend non valida.",
    });
  });

  it("azzera subito lo stato e invia al backend la sessione catturata con keepalive", async () => {
    const clearSession = vi.fn(() => true);
    window.AmaliaNativeNotifications = { clearSession };
    const endingListener = vi.fn();
    window.addEventListener("mobile:session-ending", endingListener);

    const fetchMock = vi.fn(async () => {
      expect(useAuthStore.getState().token).toBeNull();
      expect(useAuthStore.getState().userId).toBeNull();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = endCurrentSession();

    expect(snapshot).toMatchObject({
      token: "token-session",
      userId: "user-7",
      deviceUuid: "device-7",
      roomId: "room-gazebo",
    });
    expect(useAuthStore.getState()).toMatchObject({
      token: null,
      userId: null,
      username: null,
      fullName: null,
      roomId: null,
      roomName: null,
    });
    expect(endingListener).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/auth/logout");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      token: "token-session",
      userId: "user-7",
      deviceUuid: "device-7",
      roomId: "room-gazebo",
      clientApp: "mobile-frontend",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    window.removeEventListener("mobile:session-ending", endingListener);
  });
});
