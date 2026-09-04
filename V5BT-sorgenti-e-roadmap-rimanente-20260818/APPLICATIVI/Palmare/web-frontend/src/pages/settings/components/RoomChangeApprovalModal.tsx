import { useState } from "react";

interface RoomChangeApprovalModalProps {
  open: boolean;
  targetRoomName: string;
  busy: boolean;
  error: string | null;
  onConfirm: (payload: { approverUsername: string; approverPin: string }) => void;
  onCancel: () => void;
}

export function RoomChangeApprovalModal({
  open,
  targetRoomName,
  busy,
  error,
  onConfirm,
  onCancel,
}: RoomChangeApprovalModalProps) {
  const [approverUsername, setApproverUsername] = useState("");
  const [approverPin, setApproverPin] = useState("");

  if (!open) return null;

  const canConfirm = approverUsername.trim().length > 0 && approverPin.length >= 4 && !busy;

  return (
    <div
      className="room-approval-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Autorizza cambio sala"
    >
      <div className="room-approval-card">
        <div className="room-approval-title">Autorizzazione Cambio Sala</div>
        <div className="room-approval-subtitle">
          Per passare a "{targetRoomName}" serve il login di un utente autorizzato.
        </div>

        {error && <div className="error">{error}</div>}

        <div className="form room-approval-form">
          <input
            className="input"
            autoComplete="username"
            value={approverUsername}
            onChange={(e) => setApproverUsername(e.target.value)}
            placeholder="Username autorizzatore"
          />
          <input
            className="input"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="current-password"
            value={approverPin}
            onChange={(e) => setApproverPin(e.target.value.replace(/\D/g, ""))}
            placeholder="PIN autorizzatore"
          />
        </div>

        <div className="room-approval-actions">
          <button className="smallbtn" type="button" onClick={onCancel} disabled={busy}>
            Annulla
          </button>
          <button
            className="btn room-approval-confirm"
            type="button"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({
                approverUsername,
                approverPin,
              })
            }
          >
            {busy ? "Verifica..." : "Autorizza"}
          </button>
        </div>
      </div>
    </div>
  );
}
