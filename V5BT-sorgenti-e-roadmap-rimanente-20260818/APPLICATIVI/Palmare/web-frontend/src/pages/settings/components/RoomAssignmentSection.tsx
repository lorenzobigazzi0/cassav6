import { useEffect, useMemo, useRef, useState } from "react";
import type { Room } from "../../../api/locations";

interface RoomAssignmentSectionProps {
  currentRoomId: string | null;
  currentRoomName: string | null;
  rooms: Room[];
  loadingRooms: boolean;
  roomLoadError?: string | null;
  pendingApprovalRoomName: string | null;
  roomChangeBusy: boolean;
  onSelectRoom: (roomId: string) => void;
  onOpenApproval: () => void;
}

export function RoomAssignmentSection({
  currentRoomId,
  currentRoomName,
  rooms,
  loadingRooms,
  roomLoadError,
  pendingApprovalRoomName,
  roomChangeBusy,
  onSelectRoom,
  onOpenApproval,
}: RoomAssignmentSectionProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const disabled = loadingRooms || roomChangeBusy || rooms.length === 0;

  const selectedRoom = useMemo(() => {
    if (!currentRoomId) return null;
    return rooms.find((room) => room.id === currentRoomId) ?? null;
  }, [currentRoomId, rooms]);

  const selectedRoomLabel = selectedRoom?.name ?? currentRoomName ?? "Seleziona sala";

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (dropdownRef.current?.contains(node)) return;
      setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selectRoom = (roomId: string) => {
    setOpen(false);
    if (!roomId || roomId === currentRoomId) return;
    onSelectRoom(roomId);
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Sala</div>
      <div className="settings-ios-list settings-room-list">
        <div className="settings-ios-row settings-ios-row-toggle">
          <div className="settings-ios-key-wrap">
            <div className="settings-ios-key">Sala operativa</div>
          </div>
          <div className="settings-room-control">
            <input
              id="settings-room-select"
              name="settings_room_select"
              type="hidden"
              value={currentRoomId ?? ""}
              readOnly
            />

            <div className="settings-room-dropdown" ref={dropdownRef}>
              <button
                type="button"
                className={`settings-room-trigger ${open ? "is-open" : ""}`}
                aria-label="Seleziona sala operativa"
                aria-haspopup="listbox"
                aria-expanded={open}
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
              >
                <span className="settings-room-trigger-text">{selectedRoomLabel}</span>
                <svg className="settings-room-trigger-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {open && !disabled && (
                <div
                  className="settings-room-menu"
                  role="listbox"
                  aria-label="Lista sale operative"
                >
                  {rooms.length === 0 && (
                    <div
                      className="settings-room-option is-empty"
                      role="option"
                      aria-selected="false"
                    >
                      Nessuna sala disponibile
                    </div>
                  )}
                  {rooms.map((room) => {
                    const isSelected = room.id === currentRoomId;
                    return (
                      <button
                        key={room.id}
                        className={`settings-room-option ${isSelected ? "is-selected" : ""}`}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => selectRoom(room.id)}
                      >
                        <span className="settings-room-option-label">{room.name}</span>
                        {isSelected && (
                          <svg
                            className="settings-room-option-check"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {roomLoadError && (
          <div className="settings-ios-row settings-room-error-row">
            <div className="settings-ios-key-wrap">
              <div className="settings-ios-key">Sale non disponibili</div>
              <div className="settings-ios-value">{roomLoadError}</div>
            </div>
          </div>
        )}

        {pendingApprovalRoomName && (
          <div className="settings-ios-row">
            <div className="settings-ios-key-wrap">
              <div className="settings-ios-key">Richiesta in attesa</div>
            </div>
            <button
              className="smallbtn settings-approve-btn"
              type="button"
              onClick={onOpenApproval}
            >
              Autorizza
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
