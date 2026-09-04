import { apiJson } from "./baseUrl";

export type WaiterPauseState = {
  enabled: boolean;
  durationMinutes: number;
  renewalMinutes: number;
  active: boolean;
  graceActive: boolean;
  status: "paused" | "resuming" | "active";
  startedAtMs: number;
  endsAtMs: number;
  remainingMs: number;
  nextAvailableAtMs: number;
  available: boolean;
  reenableAtMs: number;
};

export type WaiterPausePayload = {
  token: string;
  userId: string;
  username?: string | null;
  fullName?: string | null;
  deviceUuid: string;
  roomId?: string | null;
  roomName?: string | null;
};

export type WaiterPauseResponse = {
  ok: true;
  pause: WaiterPauseState;
};

const pauseRequest = (path: string, payload: WaiterPausePayload) =>
  apiJson<WaiterPauseResponse>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

export const fetchWaiterPauseStatus = (payload: WaiterPausePayload) =>
  pauseRequest("/api/mobile/waiter-pause/status", payload);

export const startWaiterPause = (payload: WaiterPausePayload) =>
  pauseRequest("/api/mobile/waiter-pause/start", payload);

export const stopWaiterPause = (payload: WaiterPausePayload) =>
  pauseRequest("/api/mobile/waiter-pause/stop", payload);

