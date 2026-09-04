import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOfflineRequests: vi.fn(),
  removeOfflineRequest: vi.fn(),
  updateOfflineRequest: vi.fn(),
  getAuthState: vi.fn(),
}));

vi.mock("../src/config/runtimeConfig", () => ({
  isRuntimeFeatureEnabled: () => true,
}));

vi.mock("../src/store/authStore", () => ({
  useAuthStore: {
    getState: mocks.getAuthState,
  },
}));

vi.mock("../src/shared/offline/offlineStore", () => ({
  listOfflineRequests: mocks.listOfflineRequests,
  removeOfflineRequest: mocks.removeOfflineRequest,
  updateOfflineRequest: mocks.updateOfflineRequest,
}));

import { dispatchMobileSessionEnding } from "../src/app/session/sessionLifecycle";
import {
  installOfflineRuntime,
  OFFLINE_REPLAY_APPLIED_EVENT,
} from "../src/shared/offline/offlineRuntime";
import type { OfflineOutboxEntry } from "../src/shared/offline/offlineStore";

const pendingEntry = (): OfflineOutboxEntry => ({
  requestId: "request-logout",
  idempotencyKey: "request-logout",
  url: "/api/orders",
  method: "POST",
  headers: { Authorization: "Bearer token-old" },
  body: JSON.stringify({ userId: "user-1", deviceUuid: "device-1" }),
  replayMode: "automatic",
  status: "pending",
  attempts: 0,
  createdAt: 100,
  updatedAt: 100,
  nextAttemptAt: 0,
  expiresAt: Date.now() + 60_000,
  lastError: "",
  ownerUserId: "user-1",
  ownerActivityId: "activity-1",
  ownerDeviceUuid: "device-1",
});

describe("offline runtime logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthState.mockReturnValue({
      token: "token-current",
      userId: "user-1",
      activityId: "activity-1",
      deviceUuid: "device-1",
    });
    mocks.removeOfflineRequest.mockResolvedValue(true);
    mocks.updateOfflineRequest.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts an in-flight replay and keeps it pending without publishing an applied event", async () => {
    const entry = pendingEntry();
    mocks.listOfflineRequests.mockResolvedValueOnce([]).mockResolvedValue([entry]);

    let observedSignal: AbortSignal | undefined;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        notifyFetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          const rejectAsAborted = () => reject(new DOMException("Aborted", "AbortError"));
          if (observedSignal?.aborted) rejectAsAborted();
          else observedSignal?.addEventListener("abort", rejectAsAborted, { once: true });
        });
      })
    );
    const replayAppliedListener = vi.fn();
    window.addEventListener(OFFLINE_REPLAY_APPLIED_EVENT, replayAppliedListener);

    installOfflineRuntime();
    await fetchStarted;
    expect(observedSignal?.aborted).toBe(false);
    expect(mocks.updateOfflineRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: entry.requestId, status: "sending" })
    );

    dispatchMobileSessionEnding();

    await vi.waitFor(() => {
      expect(mocks.updateOfflineRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: entry.requestId,
          replayMode: "automatic",
          status: "pending",
          attempts: 1,
        })
      );
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(mocks.removeOfflineRequest).not.toHaveBeenCalled();
    expect(replayAppliedListener).not.toHaveBeenCalled();

    window.removeEventListener(OFFLINE_REPLAY_APPLIED_EVENT, replayAppliedListener);
  });
});
