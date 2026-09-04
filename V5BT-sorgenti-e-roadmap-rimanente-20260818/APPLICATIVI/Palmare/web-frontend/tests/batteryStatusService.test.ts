import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_BATTERY_EVENT,
  normalizeLocalBatteryState,
  readNativeBatteryState,
  subscribeNativeBatteryState,
} from "../src/app/runtime/batteryStatusService";

afterEach(() => {
  delete window.AmaliaNativeBattery;
});

describe("local battery status", () => {
  it("normalizes and clamps the native battery payload", () => {
    expect(
      normalizeLocalBatteryState({
        level: 135,
        charging: true,
        deviceName: "Samsung Test",
      })
    ).toEqual({
      kind: "ready",
      device: {
        level: 100,
        charging: true,
        online: true,
        deviceName: "Samsung Test",
      },
      stale: false,
    });
    expect(normalizeLocalBatteryState({ level: "invalid" })).toBeNull();
  });

  it("reads the current snapshot directly from the Android bridge", () => {
    window.AmaliaNativeBattery = {
      getSnapshot: () =>
        JSON.stringify({
          level: 64,
          charging: false,
          deviceName: "Palmare",
        }),
    };

    expect(readNativeBatteryState()).toMatchObject({
      kind: "ready",
      device: { level: 64, charging: false, deviceName: "Palmare" },
      stale: false,
    });
  });

  it("receives battery changes without polling the server", () => {
    const listener = vi.fn();
    const dispose = subscribeNativeBatteryState(listener);

    window.dispatchEvent(
      new CustomEvent(NATIVE_BATTERY_EVENT, {
        detail: { level: 42, charging: true, deviceName: "Palmare" },
      })
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({
      kind: "ready",
      device: { level: 42, charging: true },
    });

    dispose();
  });
});

