import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/baseUrl";
import { publishRealtimeTransportStatus } from "../src/app/runtime/realtimeTransportStatus";
import { SettingsSyncBanner } from "../src/app/runtime/SettingsSyncBanner";
import { useSettingsLiveSync } from "../src/app/runtime/useSettingsLiveSync";
import { SETTINGS_VERSION_EVENT } from "../src/shared/settings/settingsVersionEvents";

vi.mock("../src/api/baseUrl", () => ({
  apiFetch: vi.fn(),
}));

function SettingsSyncHarness({ queryClient }: { queryClient: QueryClient }) {
  const visible = useSettingsLiveSync(queryClient);
  return <output data-testid="settings-sync-banner">{visible ? "visible" : "hidden"}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.localStorage.setItem("pos:settings-version", "1");
  publishRealtimeTransportStatus("connected", "settings-sync-test");
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, settingsVersion: 1 }),
  } as Response);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("settings live sync", () => {
  it("hides the banner when the realtime transport restarts the sync effect", async () => {
    const queryClient = new QueryClient();

    render(<SettingsSyncHarness queryClient={queryClient} />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_VERSION_EVENT, {
          detail: { version: 2, source: "transport-restart-test" },
        })
      );
    });
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("visible");

    act(() => {
      publishRealtimeTransportStatus("disconnected", "settings-sync-regression");
    });
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("hidden");

    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("hidden");

    act(() => {
      publishRealtimeTransportStatus("connected", "settings-sync-reconnected");
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_VERSION_EVENT, {
          detail: { version: 3, source: "post-reconnect-test" },
        })
      );
    });
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("visible");

    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("hidden");
  });

  it("queues the newest version without extending the banner lifetime", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const emittedVersions: number[] = [];
    const onSettingsSync = (event: Event) => {
      emittedVersions.push(Number((event as CustomEvent<{ version: number }>).detail?.version));
    };
    window.addEventListener("pos:settings-sync", onSettingsSync);

    render(<SettingsSyncHarness queryClient={queryClient} />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_VERSION_EVENT, {
          detail: { version: 2, source: "test-2" },
        })
      );
      window.dispatchEvent(
        new CustomEvent(SETTINGS_VERSION_EVENT, {
          detail: { version: 3, source: "test-3" },
        })
      );
      window.dispatchEvent(
        new CustomEvent(SETTINGS_VERSION_EVENT, {
          detail: { version: 4, source: "test-4" },
        })
      );
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(emittedVersions).toEqual([2]);
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("visible");

    act(() => vi.advanceTimersByTime(1_800));

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(emittedVersions).toEqual([2, 4]);
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("hidden");

    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.getByTestId("settings-sync-banner")).toHaveTextContent("hidden");

    window.removeEventListener("pos:settings-sync", onSettingsSync);
  });

  it("removes the banner content from the DOM while it is hidden", () => {
    const { rerender } = render(<SettingsSyncBanner visible={false} />);
    expect(screen.queryByText("Configurazione aggiornata.")).not.toBeInTheDocument();

    rerender(<SettingsSyncBanner visible />);
    expect(screen.getByText("Configurazione aggiornata.")).toBeVisible();

    rerender(<SettingsSyncBanner visible={false} />);
    expect(screen.queryByText("Configurazione aggiornata.")).not.toBeInTheDocument();
  });
});
