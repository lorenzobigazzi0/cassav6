import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { changePin } from "../api/auth";
import { GlassCard } from "../components/GlassCard";
import { useAuthStore } from "../store/authStore";
import { SystemRow } from "./home/components/SystemRow";
import { useSystemTime } from "./home/hooks/useSystemTime";
import { useEdgeSwipeBack } from "./hooks/useEdgeSwipeBack";
import { HomeBackButton } from "./shared/HomeBackButton";
import { SwipeBackHomePreview } from "./shared/SwipeBackHomePreview";

type PinFieldId = "currentPin" | "newPin" | "confirmPin";

const normalizePinInput = (value: string) => value.replace(/\D/g, "").slice(0, 4);

function PinVisibilityIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M8.5 5.6A10.7 10.7 0 0 1 12 5c5 0 8.4 4.2 9.5 6.1a1.8 1.8 0 0 1 0 1.8 16.4 16.4 0 0 1-3 3.6" />
      <path d="M6.1 6.9A16.2 16.2 0 0 0 2.5 11a1.8 1.8 0 0 0 0 1.9C3.6 14.8 7 19 12 19a10.8 10.8 0 0 0 4.1-.8" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 11.1C3.6 9.2 7 5 12 5s8.4 4.2 9.5 6.1a1.8 1.8 0 0 1 0 1.8C20.4 14.8 17 19 12 19s-8.4-4.2-9.5-6.1a1.8 1.8 0 0 1 0-1.8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ChangePinField({
  id,
  label,
  value,
  visible,
  onChange,
  onToggleVisible,
}: {
  id: PinFieldId;
  label: string;
  value: string;
  visible: boolean;
  onChange: (id: PinFieldId, value: string) => void;
  onToggleVisible: (id: PinFieldId) => void;
}) {
  return (
    <label className="profile-pin-field">
      <span>{label}</span>
      <div className="profile-pin-input-wrap">
        <input
          type={visible ? "text" : "password"}
          inputMode="numeric"
          autoComplete={id === "currentPin" ? "current-password" : "new-password"}
          pattern="[0-9]*"
          maxLength={4}
          value={value}
          onChange={(event) => onChange(id, event.target.value)}
          placeholder="0000"
        />
        <button
          type="button"
          className="profile-pin-eye"
          onClick={() => onToggleVisible(id)}
          aria-label={visible ? "Nascondi PIN" : "Mostra PIN"}
        >
          <PinVisibilityIcon visible={visible} />
        </button>
      </div>
    </label>
  );
}

export function ProfilePage() {
  const navigate = useNavigate();
  const timeLabel = useSystemTime();
  const { token, userId, username, fullName, role, roleLabel, permissions, deviceUuid } =
    useAuthStore();
  const edgeSwipe = useEdgeSwipeBack(() => navigate("/"));
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [pinValues, setPinValues] = useState<Record<PinFieldId, string>>({
    currentPin: "",
    newPin: "",
    confirmPin: "",
  });
  const [visiblePins, setVisiblePins] = useState<Record<PinFieldId, boolean>>({
    currentPin: false,
    newPin: false,
    confirmPin: false,
  });
  const [pinBusy, setPinBusy] = useState(false);
  const [pinMessage, setPinMessage] = useState("");
  const [pinError, setPinError] = useState("");

  const displayName = fullName || username || "Operatore";
  const initials = useMemo(() => {
    const raw = displayName.trim();
    if (!raw) return "OP";
    const parts = raw.split(/[\s._-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }, [displayName]);

  const currentRoleLabel = useMemo(() => {
    if (roleLabel) return roleLabel;
    if (role === "admin") return "Amministratore";
    if (role === "responsabile") return "Responsabile";
    return "Operatore";
  }, [role, roleLabel]);

  const canCollect = permissions.includes("collect_payments");
  const canSubmitPin =
    /^\d{4}$/.test(pinValues.currentPin) &&
    /^\d{4}$/.test(pinValues.newPin) &&
    pinValues.newPin === pinValues.confirmPin &&
    !pinBusy;

  const resetPinModal = () => {
    setPinValues({ currentPin: "", newPin: "", confirmPin: "" });
    setVisiblePins({ currentPin: false, newPin: false, confirmPin: false });
    setPinBusy(false);
    setPinMessage("");
    setPinError("");
  };

  const closePinModal = () => {
    setChangePinOpen(false);
    resetPinModal();
  };

  const updatePinValue = (id: PinFieldId, value: string) => {
    setPinValues((current) => ({ ...current, [id]: normalizePinInput(value) }));
    setPinError("");
    setPinMessage("");
  };

  const togglePinVisibility = (id: PinFieldId) => {
    setVisiblePins((current) => ({ ...current, [id]: !current[id] }));
  };

  const submitPinChange = async () => {
    if (pinBusy) return;
    if (!token || !userId || !deviceUuid) {
      setPinError("Sessione login non valida.");
      return;
    }
    if (!/^\d{4}$/.test(pinValues.currentPin)) {
      setPinError("Inserisci il PIN attuale di 4 cifre.");
      return;
    }
    if (!/^\d{4}$/.test(pinValues.newPin)) {
      setPinError("Il nuovo PIN deve essere di 4 cifre.");
      return;
    }
    if (pinValues.newPin !== pinValues.confirmPin) {
      setPinError("Il nuovo PIN e la conferma non coincidono.");
      return;
    }
    setPinBusy(true);
    setPinError("");
    setPinMessage("");
    const response = await changePin({
      token,
      userId,
      deviceUuid,
      currentPin: pinValues.currentPin,
      newPin: pinValues.newPin,
      confirmPin: pinValues.confirmPin,
    });
    setPinBusy(false);
    if (!response.ok) {
      setPinError(response.error || "Cambio PIN non riuscito.");
      return;
    }
    setPinMessage("PIN aggiornato.");
    window.setTimeout(() => {
      closePinModal();
    }, 750);
  };

  return (
    <div className="page profile-page" {...edgeSwipe.bind}>
      <SwipeBackHomePreview timeLabel={timeLabel} revealProgress={edgeSwipe.revealProgress} />

      <div className="swipe-front-layer" style={edgeSwipe.style}>
        <div className="home-shell settings-shell profile-shell">
          <SystemRow timeLabel={timeLabel} />

          <div className="home-topbar settings-topbar settings-ios-header profile-topbar">
            <HomeBackButton onClick={() => navigate("/")} />
            <div className="settings-topbar-title">Profilo</div>
            <div className="settings-header-spacer" aria-hidden="true" />
          </div>

          <GlassCard className="settings-card settings-card-ios profile-card">
            <div className="card-body settings-body profile-body">
              <div className="settings-scroll-area">
                <div className="profile-hero">
                  <div className="profile-avatar-large" aria-hidden="true">
                    <span className="profile-avatar-initials">{initials}</span>
                  </div>
                  <div className="profile-display-name">{displayName}</div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Dati Operatore</div>
                  <div className="settings-ios-list">
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Nome utente</div>
                      <div className="settings-ios-value">{username || "operatore"}</div>
                    </div>
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Ruolo</div>
                      <div className="settings-ios-value">{currentRoleLabel}</div>
                    </div>
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Nome</div>
                      <div className="settings-ios-value">{displayName}</div>
                    </div>
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Autorizzato alla riscossione</div>
                      <div className={`settings-ios-badge ${canCollect ? "waiter" : "general"}`}>
                        {canCollect ? "Si" : "No"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="profile-actions-bottom">
                  <button
                    type="button"
                    className="profile-change-pin-button"
                    onClick={() => {
                      resetPinModal();
                      setChangePinOpen(true);
                    }}
                  >
                    Cambia PIN
                  </button>
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>

      {changePinOpen ? (
        <div className="profile-pin-modal-backdrop" role="presentation">
          <div className="profile-pin-modal" role="dialog" aria-modal="true" aria-labelledby="change-pin-title">
            <div className="profile-pin-modal-header">
              <div>
                <span>Profilo</span>
                <strong id="change-pin-title">Cambia PIN</strong>
              </div>
              <button type="button" className="profile-pin-close" onClick={closePinModal} aria-label="Chiudi" />
            </div>
            <div className="profile-pin-modal-body">
              <ChangePinField
                id="currentPin"
                label="PIN attuale"
                value={pinValues.currentPin}
                visible={visiblePins.currentPin}
                onChange={updatePinValue}
                onToggleVisible={togglePinVisibility}
              />
              <ChangePinField
                id="newPin"
                label="Nuovo PIN"
                value={pinValues.newPin}
                visible={visiblePins.newPin}
                onChange={updatePinValue}
                onToggleVisible={togglePinVisibility}
              />
              <ChangePinField
                id="confirmPin"
                label="Ripeti nuovo PIN"
                value={pinValues.confirmPin}
                visible={visiblePins.confirmPin}
                onChange={updatePinValue}
                onToggleVisible={togglePinVisibility}
              />
              <div className="profile-pin-hint">Il PIN deve essere composto da 4 cifre.</div>
              {pinError ? <div className="profile-pin-feedback is-error">{pinError}</div> : null}
              {pinMessage ? <div className="profile-pin-feedback is-success">{pinMessage}</div> : null}
            </div>
            <div className="profile-pin-modal-actions">
              <button type="button" className="profile-pin-secondary" onClick={closePinModal}>
                Annulla
              </button>
              <button
                type="button"
                className="profile-pin-primary"
                onClick={submitPinChange}
                disabled={!canSubmitPin}
              >
                {pinBusy ? "Salvataggio..." : "Conferma"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
