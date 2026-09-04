export type SystemConnectionState = "online" | "reconnecting" | "offline";

export const SYSTEM_CONNECTION_COLORS: Record<SystemConnectionState, string> = {
  online: "#2fdc86",
  reconnecting: "#f2b84d",
  offline: "#ff6a6a",
};

export function getSystemConnectionLabel(state: SystemConnectionState) {
  if (state === "offline") return "Server offline";
  if (state === "reconnecting") return "Server in riconnessione";
  return "Server connesso";
}

export function getSystemConnectionRingColor(state: SystemConnectionState) {
  return SYSTEM_CONNECTION_COLORS[state];
}
