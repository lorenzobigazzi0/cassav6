import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineQueueStatusBanner } from "../src/app/runtime/OfflineQueueStatusBanner";
import { getOfflineQueueSummary } from "../src/shared/offline/offlineStore";

const authState = {
  token: "token-1",
  userId: "user-1",
  deviceUuid: "device-1",
};

vi.mock("../src/store/authStore", () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

vi.mock("../src/shared/offline/offlineStore", () => ({
  OFFLINE_STATE_EVENT: "palmare:offline-state",
  getOfflineQueueSummary: vi.fn(),
}));

const mockedGetSummary = vi.mocked(getOfflineQueueSummary);

describe("OfflineQueueStatusBanner", () => {
  beforeEach(() => {
    mockedGetSummary.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows operations held for verification for the current user and device", async () => {
    mockedGetSummary.mockResolvedValue({ pending: 0, held: 0, failed: 1, conflict: 1 });

    render(<OfflineQueueStatusBanner />);

    expect(
      await screen.findByText("2 operazioni richiedono verifica prima della sincronizzazione.")
    ).toBeInTheDocument();
    expect(mockedGetSummary).toHaveBeenCalledWith({
      ownerUserId: "user-1",
      ownerDeviceUuid: "device-1",
    });
  });

  it("refreshes the pending count when the offline store changes", async () => {
    mockedGetSummary
      .mockResolvedValueOnce({ pending: 1, held: 0, failed: 0, conflict: 0 })
      .mockResolvedValueOnce({ pending: 3, held: 0, failed: 0, conflict: 0 });

    render(<OfflineQueueStatusBanner />);
    expect(
      await screen.findByText("1 operazione in attesa di sincronizzazione.")
    ).toBeInTheDocument();

    act(() => window.dispatchEvent(new CustomEvent("palmare:offline-state")));

    await waitFor(() => {
      expect(screen.getByText("3 operazioni in attesa di sincronizzazione.")).toBeInTheDocument();
    });
  });
});
