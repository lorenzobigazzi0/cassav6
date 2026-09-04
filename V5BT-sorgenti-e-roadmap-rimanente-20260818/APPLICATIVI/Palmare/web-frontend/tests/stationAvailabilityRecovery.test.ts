import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchActiveStationCount } from "../src/api/stations";
import {
  isNoActiveStationOrderWarning,
  readRealtimeActiveStationCount,
  useStationAvailabilityRecovery,
} from "../src/pages/home/tables/hooks/useStationAvailabilityRecovery";

vi.mock("../src/api/stations", () => ({
  fetchActiveStationCount: vi.fn(),
}));

const mockedFetchActiveStationCount = vi.mocked(fetchActiveStationCount);

describe("station availability warning recovery", () => {
  beforeEach(() => {
    mockedFetchActiveStationCount.mockReset();
    mockedFetchActiveStationCount.mockResolvedValue(0);
  });

  it("recognizes the backend warning by code and legacy message", () => {
    expect(isNoActiveStationOrderWarning("station_paused_only_target", "")).toBe(true);
    expect(isNoActiveStationOrderWarning("", "Nessuna postazione attiva, ordine in coda")).toBe(
      true
    );
    expect(isNoActiveStationOrderWarning("", "Backend offline")).toBe(false);
  });

  it("reads station recovery from realtime payloads only", () => {
    expect(
      readRealtimeActiveStationCount({ reason: "station_state_changed", active: true })
    ).toBe(1);
    expect(
      readRealtimeActiveStationCount({ reason: "station_availability_alert", activeStations: 2 })
    ).toBe(2);
    expect(readRealtimeActiveStationCount({ reason: "order_created", activeStations: 4 })).toBe(
      null
    );
  });

  it("clears the warning while the table detail remains mounted", async () => {
    const onRestored = vi.fn();
    renderHook(() =>
      useStationAvailabilityRecovery({
        enabled: true,
        onRestored,
      })
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("pos:server-payload", {
          detail: { reason: "station_state_changed", active: true },
        })
      );
    });

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });
});
