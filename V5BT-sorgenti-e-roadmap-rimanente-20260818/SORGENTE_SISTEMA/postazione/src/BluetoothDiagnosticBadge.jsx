import { useEffect, useState } from "react";
import { subscribeToBluetoothConnectivity } from "./bluetoothDiagnosticConnectivity.js";

const PRESENTATION_BY_STATE = {
  DISABLED: { label: "Diagnostica Bluetooth disattivata", tone: "inactive" },
  PERMISSION_REQUIRED: {
    label: "Diagnostica Bluetooth: autorizzazione richiesta",
    tone: "attention",
  },
  STARTING: { label: "Diagnostica Bluetooth: avvio", tone: "pending" },
  DISCOVERING: { label: "Diagnostica Bluetooth: ricerca", tone: "pending" },
  DIRECT_SERVER: {
    label: "Diagnostica Bluetooth: server diretto attivo",
    tone: "active",
  },
  PEER_CONNECTED: {
    label: "Diagnostica Bluetooth: collegamento peer rilevato",
    tone: "active",
  },
  DEGRADED: {
    label: "Diagnostica Bluetooth: servizio degradato",
    tone: "attention",
  },
  BACKOFF: {
    label: "Diagnostica Bluetooth: attesa prima del nuovo tentativo",
    tone: "attention",
  },
  STOPPED: { label: "Diagnostica Bluetooth: arrestata", tone: "inactive" },
};

export function BluetoothDiagnosticBadge() {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => subscribeToBluetoothConnectivity(setSnapshot), []);

  if (!snapshot) return null;
  const presentation = PRESENTATION_BY_STATE[snapshot.state];

  return (
    <span
      className={`bluetooth-diagnostic-badge is-${presentation.tone}`}
      data-bluetooth-state={snapshot.state}
      role="status"
      aria-atomic="true"
      aria-label={presentation.label}
      title={presentation.label}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m7 7 10 10-5 5V2l5 5L7 17" />
      </svg>
    </span>
  );
}
