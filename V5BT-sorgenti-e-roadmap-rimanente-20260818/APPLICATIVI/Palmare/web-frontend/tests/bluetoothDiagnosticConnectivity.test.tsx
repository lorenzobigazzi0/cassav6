import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLUETOOTH_CONNECTIVITY_EVENT,
  parseBluetoothConnectivitySnapshot,
  subscribeToBluetoothConnectivity,
} from "../src/app/runtime/bluetoothDiagnosticConnectivity";
import { BluetoothDiagnosticBadge } from "../src/pages/home/components/BluetoothDiagnosticBadge";

const snapshot = (sequence = 0, state = "DISCOVERING") => ({
  schemaVersion: 1,
  source: "V5BT_ANDROID_CONNECTIVITY_AGENT",
  sequence,
  state,
});

const installBridge = (value: unknown) => {
  Object.defineProperty(window, "V5BTBluetoothState", {
    configurable: true,
    value: { getState: vi.fn(() => value) },
  });
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "V5BTBluetoothState");
});

describe("Bluetooth diagnostic snapshot parser", () => {
  it("accepts only the exact bounded redacted contract", () => {
    expect(
      parseBluetoothConnectivitySnapshot(JSON.stringify(snapshot(7, "PEER_CONNECTED")))
    ).toEqual(snapshot(7, "PEER_CONNECTED"));
    expect(parseBluetoothConnectivitySnapshot(snapshot(8, "DIRECT_SERVER"))).toEqual(
      snapshot(8, "DIRECT_SERVER")
    );

    expect(parseBluetoothConnectivitySnapshot({ ...snapshot(), nodeId: "forbidden" })).toBeNull();
    expect(parseBluetoothConnectivitySnapshot({ ...snapshot(), source: "OTHER" })).toBeNull();
    expect(parseBluetoothConnectivitySnapshot({ ...snapshot(), schemaVersion: 2 })).toBeNull();
    expect(parseBluetoothConnectivitySnapshot({ ...snapshot(), sequence: -1 })).toBeNull();
    expect(
      parseBluetoothConnectivitySnapshot({ ...snapshot(), sequence: Number.MAX_SAFE_INTEGER + 1 })
    ).toBeNull();
    expect(parseBluetoothConnectivitySnapshot({ ...snapshot(), state: "ONLINE" })).toBeNull();
    expect(parseBluetoothConnectivitySnapshot(`{"padding":"${"x".repeat(513)}"}`)).toBeNull();
    expect(
      parseBluetoothConnectivitySnapshot(
        new Proxy(snapshot(), {
          ownKeys: () => {
            throw new Error("hostile payload");
          },
        })
      )
    ).toBeNull();
  });
});

describe("Bluetooth diagnostic subscription", () => {
  it("fails closed without the native feature bridge", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBluetoothConnectivity(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it("fails closed when the native event surface is unavailable", () => {
    const listener = vi.fn();
    const target = {
      V5BTBluetoothState: {
        getState: () => JSON.stringify(snapshot()),
      },
    } as unknown as Window;

    const unsubscribe = subscribeToBluetoothConnectivity(listener, target);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it("uses the initial bridge state, events, monotonic ordering and cleanup", () => {
    installBridge(JSON.stringify(snapshot(2, "DISCOVERING")));
    const listener = vi.fn();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const unsubscribe = subscribeToBluetoothConnectivity(listener);

    expect(listener).toHaveBeenLastCalledWith(snapshot(2, "DISCOVERING"));

    window.dispatchEvent(
      new CustomEvent(BLUETOOTH_CONNECTIVITY_EVENT, {
        detail: snapshot(1, "STOPPED"),
      })
    );
    expect(listener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new CustomEvent(BLUETOOTH_CONNECTIVITY_EVENT, {
        detail: snapshot(3, "DEGRADED"),
      })
    );
    expect(listener).toHaveBeenLastCalledWith(snapshot(3, "DEGRADED"));

    window.dispatchEvent(
      new CustomEvent(BLUETOOTH_CONNECTIVITY_EVENT, {
        detail: { ...snapshot(4), mac: "forbidden" },
      })
    );
    expect(listener).toHaveBeenLastCalledWith(null);

    unsubscribe();
    unsubscribe();
    expect(removeSpy).toHaveBeenCalledOnce();

    window.dispatchEvent(
      new CustomEvent(BLUETOOTH_CONNECTIVITY_EVENT, {
        detail: snapshot(5, "PEER_CONNECTED"),
      })
    );
    expect(listener).toHaveBeenLastCalledWith(null);
    removeSpy.mockRestore();
  });
});

describe("Bluetooth diagnostic badge", () => {
  it("is absent without a valid native snapshot and exposes no identifiers", () => {
    const { container } = render(<BluetoothDiagnosticBadge />);
    expect(container).toBeEmptyDOMElement();

    cleanup();
    installBridge(JSON.stringify({ ...snapshot(), token: "forbidden" }));
    const invalid = render(<BluetoothDiagnosticBadge />);
    expect(invalid.container).toBeEmptyDOMElement();
  });

  it("announces only the diagnostic state and reacts to native events", () => {
    installBridge(JSON.stringify(snapshot(4, "DISCOVERING")));
    const { container, unmount } = render(<BluetoothDiagnosticBadge />);

    expect(screen.getByRole("status")).toHaveAccessibleName("Diagnostica Bluetooth: ricerca");
    expect(container.querySelector("[data-bluetooth-state='DISCOVERING']")).toBeInTheDocument();
    expect(container.textContent).toBe("");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(BLUETOOTH_CONNECTIVITY_EVENT, {
          detail: snapshot(5, "PERMISSION_REQUIRED"),
        })
      );
    });
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Diagnostica Bluetooth: autorizzazione richiesta"
    );

    unmount();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(BLUETOOTH_CONNECTIVITY_EVENT, {
          detail: snapshot(6, "PEER_CONNECTED"),
        })
      );
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
