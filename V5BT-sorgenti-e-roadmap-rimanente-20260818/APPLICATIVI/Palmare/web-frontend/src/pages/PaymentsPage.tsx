import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GlassCard } from "../components/GlassCard";
import { apiFetch } from "../api/baseUrl";
import { resetAutomaticCashGateway, restartAutomaticCashGateway } from "../api/automaticCash";
import { formatCurrency } from "../shared/format/currency";
import { usePaymentSettingsStore } from "../store/paymentSettingsStore";
import { useAuthStore } from "../store/authStore";
import { appendAnalyticsTransaction } from "../utils/analyticsTransactions";
import { formatAutomaticCashError } from "../utils/automaticCashErrors";
import {
  getCounterCashDefaultSource,
  saveCounterCashDefaultSourcePreference,
  subscribeCounterCashDefaultSource,
  syncCounterCashDefaultSourceFromDb,
  type CounterCashDefaultSource,
} from "../utils/automaticCashPaymentPreferences";
import { getOrCreateDeviceUuid } from "../utils/device";
import { GlassDropdown, type GlassDropdownOption } from "./home/tables/components/GlassDropdown";
import { SystemRow } from "./home/components/SystemRow";
import { useSystemTime } from "./home/hooks/useSystemTime";
import { useEdgeSwipeBack } from "./hooks/useEdgeSwipeBack";
import { HomeBackButton } from "./shared/HomeBackButton";
import { SwipeBackHomePreview } from "./shared/SwipeBackHomePreview";
import { AutomaticCashFloatModal } from "./payments/AutomaticCashFloatModal";
import { CashExchangeWizard } from "./payments/CashExchangeWizard";
import { CashFloatLoadChoiceModal } from "./payments/CashFloatLoadChoiceModal";
import { CashMovementModal } from "./payments/CashMovementModal";
import { ManualCashFloatModal } from "./payments/ManualCashFloatModal";
import { usePaymentOverviewSnapshot } from "./payments/PaymentOverviewProvider";

const PaymentSettlementSection = lazy(() =>
  import("./payments/PaymentSettlementSection").then((module) => ({
    default: module.PaymentSettlementSection,
  }))
);

type AutoCashModalMode = "operator-load" | "admin-create";

const EMPTY_POS_OPTION: GlassDropdownOption = { value: "", label: "Nessun POS" };

const canManageAutomaticCashRole = (value?: string | null) =>
  ["admin", "responsabile"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );

const toOperatorName = (params: {
  fullName?: string | null;
  username?: string | null;
  userId?: string | null;
}) => {
  const fullName = String(params.fullName ?? "").trim();
  if (fullName) return fullName;

  const username = String(params.username ?? "").trim();
  if (username) {
    return username
      .replace(/[^a-z0-9]+/gi, " ")
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  const normalized = String(params.userId ?? "")
    .trim()
    .replace(/^u_/, "");
  if (!normalized) return "Operatore";
  return normalized
    .replace(/[^a-z0-9]+/gi, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

function PaymentSettlementFallback() {
  return (
    <div className="payments-section mobile-payments-settlement-section">
      <div className="payments-section-title">Scarico cassa</div>
      <div className="payments-note">Caricamento movimenti...</div>
    </div>
  );
}

const ignoreStatusMessage = () => undefined;

export function PaymentsPage() {
  const navigate = useNavigate();
  const timeLabel = useSystemTime();
  const edgeSwipe = useEdgeSwipeBack(() => navigate("/"));
  const {
    fullName,
    username,
    userId,
    token,
    deviceUuid,
    activityId,
    roomId,
    roomName,
    sessionStartedAt,
    role,
    permissions,
  } = useAuthStore();
  const {
    posId,
    cashMode,
    cashFloat,
    cashFloatLocked,
    autoCashFloatLoaded,
    setPosId,
    lockCashFloat,
  } = usePaymentSettingsStore();
  const {
    paymentTerminals: posTerminals,
    paymentTerminalsLoading: posTerminalsLoading,
    paymentTerminalsError: posTerminalsUnavailable,
    automaticCashStatus,
    automaticCashGatewayState,
    activeCashExchange,
    activeCashMovement,
    runtimeLoading: cashExchangeRuntimeLoading,
    runtimeGatewayError,
    gatewayOperational,
    refreshRuntime: refreshCashExchangeRuntime,
  } = usePaymentOverviewSnapshot();

  const [cashDraft, setCashDraft] = useState(() =>
    cashMode === "manual" && cashFloat !== null ? cashFloat.toFixed(2) : ""
  );
  const [cashConfirmOpen, setCashConfirmOpen] = useState(false);
  const [cashLoadChoiceOpen, setCashLoadChoiceOpen] = useState(false);
  const [autoCashModalOpen, setAutoCashModalOpen] = useState(false);
  const [autoCashModalMode, setAutoCashModalMode] = useState<AutoCashModalMode>("operator-load");
  const [cashExchangeOpen, setCashExchangeOpen] = useState(false);
  const [cashMovementModalType, setCashMovementModalType] = useState<"load" | "withdrawal" | null>(
    null
  );
  const [gatewayCommandBusy, setGatewayCommandBusy] = useState<"" | "restart" | "reset">("");
  const [gatewayCommandMessage, setGatewayCommandMessage] = useState("");
  const [gatewayCommandError, setGatewayCommandError] = useState("");
  const [gatewayCommandConfirm, setGatewayCommandConfirm] = useState<"" | "restart" | "reset">("");
  const [counterCashSource, setCounterCashSource] = useState<CounterCashDefaultSource>(() =>
    getCounterCashDefaultSource(userId)
  );
  const [counterCashSaving, setCounterCashSaving] = useState(false);
  const [counterCashError, setCounterCashError] = useState("");

  useEffect(() => {
    if (cashMode === "manual" && cashFloatLocked && cashFloat !== null) {
      setCashDraft(cashFloat.toFixed(2));
    } else if (cashMode === "auto") {
      setCashDraft("");
    }
  }, [cashFloat, cashFloatLocked, cashMode]);

  const hasPos = Boolean(posId);
  const hasCashFloat = cashFloatLocked && cashFloat !== null;
  const hasManualCashFloat = cashMode === "manual" && hasCashFloat;
  const hasAutoCashFloat = cashMode === "auto" && autoCashFloatLoaded && hasCashFloat;
  const hasLoadedCashFloat = hasManualCashFloat || hasAutoCashFloat;
  const hasPaymentMethod = hasPos || hasCashFloat;
  const paymentsEnabled = hasPaymentMethod;
  const showSettlementSection = hasLoadedCashFloat;
  const canAdminAutoCash =
    canManageAutomaticCashRole(role) ||
    permissions.some(
      (permission) =>
        permission === "automatic_cash_admin" || String(permission) === "manage_settings"
    );
  const operatorName = useMemo(
    () => toOperatorName({ fullName, username, userId }),
    [fullName, username, userId]
  );
  const effectiveDeviceUuid = useMemo(() => deviceUuid || getOrCreateDeviceUuid(), [deviceUuid]);

  useEffect(() => {
    setCounterCashSource(getCounterCashDefaultSource(userId));
  }, [userId]);

  useEffect(() => {
    return subscribeCounterCashDefaultSource(() => {
      setCounterCashSource(getCounterCashDefaultSource(userId));
    });
  }, [userId]);

  useEffect(() => {
    if (!token || !userId || !effectiveDeviceUuid) return;
    let active = true;
    setCounterCashError("");
    void syncCounterCashDefaultSourceFromDb({
      token,
      userId,
      deviceUuid: effectiveDeviceUuid,
    })
      .then((value) => {
        if (active) setCounterCashSource(value);
      })
      .catch(() => {
        if (active) {
          setCounterCashError("Preferenza Banco non sincronizzata: uso il valore locale.");
        }
      });
    return () => {
      active = false;
    };
  }, [effectiveDeviceUuid, token, userId]);

  const updateCounterCashSource = (value: CounterCashDefaultSource) => {
    if (counterCashSaving || value === counterCashSource) return;
    setCounterCashSource(value);
    setCounterCashSaving(true);
    setCounterCashError("");
    void saveCounterCashDefaultSourcePreference(value, {
      token,
      userId,
      deviceUuid: effectiveDeviceUuid,
    })
      .then((saved) => {
        setCounterCashSource(saved);
      })
      .catch(() => {
        setCounterCashError("Preferenza Banco salvata solo sul dispositivo: DB non raggiungibile.");
      })
      .finally(() => {
        setCounterCashSaving(false);
      });
  };

  const posOptions = useMemo<GlassDropdownOption[]>(() => {
    const terminalOptions = posTerminals
      .filter((terminal) => terminal.enabled && terminal.id)
      .map((terminal) => ({
        value: terminal.id,
        label: terminal.label || terminal.id,
      }));
    const selectedValue = String(posId ?? "").trim();
    const selectedIsKnown =
      !selectedValue || terminalOptions.some((option) => option.value === selectedValue);
    const unknownSelected = selectedIsKnown
      ? []
      : [{ value: selectedValue, label: "POS selezionato" }];
    return [EMPTY_POS_OPTION, ...unknownSelected, ...terminalOptions];
  }, [posId, posTerminals]);

  const selectedPosLabel = useMemo(() => {
    const match = posOptions.find((option) => option.value === (posId ?? ""));
    return match?.label ?? "Nessun POS";
  }, [posId, posOptions]);

  const activeAutomaticCashWorkflow = automaticCashStatus?.activeWorkflow ?? null;
  const hasBlockingAutomaticCashWorkflow = Boolean(
    activeAutomaticCashWorkflow &&
    !["COMPLETED", "CANCELLED"].includes(activeAutomaticCashWorkflow.step)
  );
  const cashExchangeRuntimeError = runtimeGatewayError
    ? "Stato gateway non aggiornato: operazioni hardware sospese."
    : "";
  const posTerminalsError = posTerminalsUnavailable ? "Terminali POS non disponibili." : "";
  const canResumeAutomaticCashWorkflow = Boolean(
    activeAutomaticCashWorkflow?.resumableByCurrentUser
  );
  const activeAutomaticCashWorkflowOwnedByCurrentUser = Boolean(
    activeAutomaticCashWorkflow?.ownerUserId &&
    userId &&
    activeAutomaticCashWorkflow.ownerUserId === userId
  );
  const activeAutomaticCashWorkflowLockHeldByManager = Boolean(
    activeAutomaticCashWorkflow?.operationLock?.ownerCanManageAutomaticCash
  );
  const canAttemptResumeAutomaticCashWorkflow = Boolean(
    activeAutomaticCashWorkflow &&
    (canResumeAutomaticCashWorkflow ||
      activeAutomaticCashWorkflowOwnedByCurrentUser ||
      (canAdminAutoCash && !activeAutomaticCashWorkflowLockHeldByManager))
  );
  const activeAutomaticCashWorkflowOwner = String(
    activeAutomaticCashWorkflow?.ownerFullName ?? ""
  ).trim();
  const canResumeCashExchange = Boolean(activeCashExchange?.resumableByCurrentUser);
  const hasActiveCashExchange = Boolean(activeCashExchange);
  const hasActiveCashMovement = Boolean(activeCashMovement);
  const canResumeCashMovement = Boolean(activeCashMovement?.resumableByCurrentUser);
  const automaticCashGatewayListening = Boolean(
    automaticCashGatewayState?.configured && automaticCashGatewayState?.reachable
  );
  const automaticCashGatewayBusy = Boolean(
    hasBlockingAutomaticCashWorkflow ||
    hasActiveCashMovement ||
    automaticCashGatewayState?.busy ||
    (automaticCashStatus?.activeOperationId &&
      automaticCashStatus.activeOperationType !== "cash_exchange")
  );
  const automaticCashGatewayAvailable =
    !cashExchangeRuntimeLoading && gatewayOperational && automaticCashGatewayListening;
  const automaticCashGatewayDisabledReason = (() => {
    if (cashExchangeRuntimeLoading) return "";
    if (cashExchangeRuntimeError) return cashExchangeRuntimeError;
    if (!automaticCashGatewayState?.configured) return "Gateway cassa automatica non configurato.";
    if (!automaticCashGatewayState?.reachable) return "Gateway cassa automatica non raggiungibile.";
    return "";
  })();
  const cashExchangeGatewayReady = automaticCashGatewayAvailable;
  const canOpenAutomaticCashFloatAction =
    automaticCashGatewayAvailable &&
    (canAttemptResumeAutomaticCashWorkflow ||
      (!hasBlockingAutomaticCashWorkflow &&
        !hasActiveCashExchange &&
        !hasActiveCashMovement &&
        !automaticCashGatewayState?.busy &&
        canAdminAutoCash));
  const automaticCashFloatActionLabel = canAttemptResumeAutomaticCashWorkflow
    ? "RIPRENDI FONDO CASSA"
    : hasBlockingAutomaticCashWorkflow
      ? "FONDO CASSA IN CORSO"
      : "GENERA FONDO CASSA";
  const automaticCashFloatDisabledReason = (() => {
    if (!automaticCashGatewayAvailable && automaticCashGatewayDisabledReason) {
      return automaticCashGatewayDisabledReason;
    }
    if (canAttemptResumeAutomaticCashWorkflow) return "";
    if (hasBlockingAutomaticCashWorkflow) {
      return activeAutomaticCashWorkflowOwner
        ? `Fondo cassa gia in corso da parte di ${activeAutomaticCashWorkflowOwner}.`
        : "Fondo cassa gia in corso.";
    }
    if (!canAdminAutoCash) return "Funzione disponibile solo agli admin";
    return automaticCashGatewayDisabledReason;
  })();
  const cashExchangeBusyByOtherOperation = Boolean(
    (automaticCashGatewayState?.busy && !hasActiveCashExchange) ||
    (automaticCashStatus?.activeOperationId &&
      automaticCashStatus.activeOperationType !== "cash_exchange")
  );
  const canStartCashExchange =
    cashExchangeGatewayReady &&
    !cashExchangeRuntimeLoading &&
    !cashExchangeBusyByOtherOperation &&
    !hasBlockingAutomaticCashWorkflow &&
    (!hasActiveCashExchange || canResumeCashExchange);
  const cashExchangeDisabledReason = (() => {
    if (cashExchangeRuntimeLoading) return "";
    if (cashExchangeRuntimeError) return `Cambio non disponibile: ${cashExchangeRuntimeError}`;
    if (!automaticCashGatewayState?.configured)
      return "Cambio non disponibile: gateway non configurato.";
    if (!automaticCashGatewayState?.reachable)
      return "Cambio non disponibile: cassa automatica non raggiungibile.";
    if (hasBlockingAutomaticCashWorkflow)
      return "Cambio non disponibile: fondo cassa automatico in corso.";
    if (cashExchangeBusyByOtherOperation)
      return "Cambio non disponibile: cassa automatica occupata.";
    if (hasActiveCashExchange && !canResumeCashExchange) {
      const owner = String(activeCashExchange?.ownerFullName ?? "").trim();
      return owner ? `Cambio gia in corso da parte di ${owner}.` : "Cambio gia in corso.";
    }
    return "";
  })();
  const cashMovementBusyByOtherOperation = Boolean(
    hasBlockingAutomaticCashWorkflow ||
    hasActiveCashExchange ||
    (automaticCashGatewayState?.busy && !hasActiveCashMovement) ||
    (automaticCashStatus?.activeOperationId &&
      automaticCashStatus.activeOperationType !== "cash_movement")
  );
  const canOpenCashMovement = (type: "load" | "withdrawal") =>
    automaticCashGatewayAvailable &&
    !cashExchangeRuntimeLoading &&
    !cashMovementBusyByOtherOperation &&
    (!activeCashMovement || (activeCashMovement.type === type && canResumeCashMovement));
  const cashMovementDisabledReason = (type: "load" | "withdrawal") => {
    if (cashExchangeRuntimeLoading) return "";
    if (cashExchangeRuntimeError) return cashExchangeRuntimeError;
    if (!automaticCashGatewayState?.configured) return "Cassa automatica non configurata.";
    if (!automaticCashGatewayState?.reachable) return "Cassa automatica non raggiungibile.";
    if (cashMovementBusyByOtherOperation)
      return "Cassa automatica occupata da un'altra operazione.";
    if (activeCashMovement && activeCashMovement.type !== type) {
      return `Completa prima il ${
        activeCashMovement.type === "load" ? "caricamento" : "prelievo"
      } in corso.`;
    }
    if (activeCashMovement && !canResumeCashMovement) {
      const owner = String(activeCashMovement.ownerFullName ?? "").trim();
      return owner ? `Movimento in corso da parte di ${owner}.` : "Movimento cassa gia in corso.";
    }
    return "";
  };
  const gatewayMaintenanceBusy = Boolean(
    automaticCashGatewayBusy ||
    hasActiveCashExchange ||
    hasActiveCashMovement ||
    cashExchangeBusyByOtherOperation
  );
  const canRunGatewayMaintenance =
    canAdminAutoCash && automaticCashGatewayAvailable && !gatewayMaintenanceBusy;
  const gatewayMaintenanceDisabledReason = (() => {
    if (gatewayCommandBusy) return "Comando cassa automatica in corso.";
    if (!canAdminAutoCash) return "Funzione disponibile solo agli admin";
    if (automaticCashGatewayDisabledReason) return automaticCashGatewayDisabledReason;
    if (gatewayMaintenanceBusy) return "Cassa automatica occupata: chiudi l'operazione in corso.";
    return "";
  })();

  const openCashLoadChoice = () => {
    if (hasLoadedCashFloat) return;
    setCashLoadChoiceOpen(true);
  };

  const closeCashLoadChoice = () => {
    setCashLoadChoiceOpen(false);
  };

  const openManualCashModal = () => {
    if (cashMode === "manual" && cashFloat !== null) {
      setCashDraft(cashFloat.toFixed(2));
    }
    setCashLoadChoiceOpen(false);
    setCashConfirmOpen(true);
  };

  const openOperatorAutoCashModal = () => {
    if (hasLoadedCashFloat) return;
    if (!automaticCashGatewayAvailable) return;
    setCashLoadChoiceOpen(false);
    setAutoCashModalMode("operator-load");
    setAutoCashModalOpen(true);
  };

  const openAdminAutoCashModal = () => {
    if (!canOpenAutomaticCashFloatAction) return;
    const shouldResumeOperatorLoad =
      canAttemptResumeAutomaticCashWorkflow &&
      activeAutomaticCashWorkflow?.reason === "operator_cash_float" &&
      activeAutomaticCashWorkflowOwnedByCurrentUser &&
      activeAutomaticCashWorkflow?.resumableByManager !== true;
    setAutoCashModalMode(shouldResumeOperatorLoad ? "operator-load" : "admin-create");
    setAutoCashModalOpen(true);
  };

  const openCashExchangeModal = () => {
    if (!canStartCashExchange) return;
    setCashExchangeOpen(true);
  };

  const openCashMovementModal = (type: "load" | "withdrawal") => {
    if (!canOpenCashMovement(type)) return;
    setCashMovementModalType(type);
  };

  const closeCashConfirm = () => {
    setCashConfirmOpen(false);
  };

  const closeAutoCashModal = () => {
    setAutoCashModalOpen(false);
    void refreshCashExchangeRuntime();
  };

  const closeCashExchangeModal = () => {
    setCashExchangeOpen(false);
    void refreshCashExchangeRuntime();
  };

  const closeCashMovementModal = () => {
    setCashMovementModalType(null);
    void refreshCashExchangeRuntime();
  };

  const runGatewayMaintenanceCommand = async (command: "restart" | "reset") => {
    if (!canRunGatewayMaintenance || gatewayCommandBusy) return;
    const label = command === "restart" ? "riavvio" : "reset";
    setGatewayCommandConfirm("");
    setGatewayCommandBusy(command);
    setGatewayCommandMessage("");
    setGatewayCommandError("");
    try {
      const request = { reason: `${command}_from_payments_page` };
      if (command === "restart") {
        await restartAutomaticCashGateway(request);
      } else {
        await resetAutomaticCashGateway(request);
      }
      setGatewayCommandMessage(`Comando ${label} inviato alla cassa automatica.`);
      void refreshCashExchangeRuntime();
    } catch (caught) {
      setGatewayCommandError(
        formatAutomaticCashError(caught, `Comando ${label} cassa automatica non riuscito.`)
      );
    } finally {
      setGatewayCommandBusy("");
    }
  };

  const confirmManualCashFloat = (value: number) => {
    if (cashFloatLocked) return;
    lockCashFloat(value);
    if (token && userId && value > 0) {
      void apiFetch("/api/reports/handheld-session/cash/open", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-User-Id": userId,
          "X-Device-Uuid": effectiveDeviceUuid,
        },
        body: JSON.stringify({
          token,
          userId,
          deviceUuid: effectiveDeviceUuid,
          clientApp: "mobile-frontend",
          cashFloat: value,
          posId: posId ?? "",
          activityId: activityId ?? "",
          roomId: roomId ?? "",
          roomName: roomName ?? "",
          sessionStartedAt: sessionStartedAt ?? Date.now(),
        }),
      }).catch(() => {
        // Se la registrazione apertura fallisce, la chiusura scarico ricostruisce comunque la sessione.
      });
    }
    appendAnalyticsTransaction({
      kind: "cash_float_locked",
      description: "Fondo cassa confermato",
      amount: value,
      cashFloatAmount: value,
      operatorName,
      operatorId: userId ?? undefined,
      shiftToken: token ?? undefined,
    });
    setCashDraft(value.toFixed(2));
    setCashConfirmOpen(false);
  };

  return (
    <div className="page payments-page" {...edgeSwipe.bind}>
      <SwipeBackHomePreview timeLabel={timeLabel} revealProgress={edgeSwipe.revealProgress} />

      <div className="swipe-front-layer" style={edgeSwipe.style}>
        <div className="home-shell settings-shell payments-shell">
          <SystemRow timeLabel={timeLabel} />

          <div className="home-topbar settings-topbar settings-ios-header payments-topbar">
            <HomeBackButton onClick={() => navigate("/")} />
            <div className="settings-topbar-title">Pagamenti</div>
            <div className="settings-header-spacer" aria-hidden="true" />
          </div>

          <GlassCard className="settings-card settings-card-ios payments-card">
            <div className="card-body settings-body">
              <div className="settings-scroll-area payments-scroll">
                <div className="payments-section payments-overview-section">
                  <div className="payments-section-head">
                    <strong>Quadro pagamenti</strong>
                  </div>
                  <div className="payments-status-grid">
                    <div className={`payments-status-card ${paymentsEnabled ? "is-on" : "is-off"}`}>
                      <span>Pagamenti</span>
                      <strong>{paymentsEnabled ? "Attivi" : "Non attivi"}</strong>
                    </div>
                    <div className={`payments-status-card ${hasPos ? "is-on" : "is-off"}`}>
                      <span>Carta</span>
                      <strong>{hasPos ? "Disponibile" : "Non disponibile"}</strong>
                    </div>
                    <div className={`payments-status-card ${hasCashFloat ? "is-on" : "is-off"}`}>
                      <span>Contanti</span>
                      <strong>{hasCashFloat ? "Disponibile" : "Non disponibile"}</strong>
                    </div>
                    <div
                      className={`payments-status-card ${
                        automaticCashGatewayAvailable || automaticCashGatewayBusy
                          ? "is-on"
                          : "is-off"
                      }`}
                    >
                      <span>Gateway</span>
                      <strong>
                        {cashExchangeRuntimeLoading
                          ? "Verifica"
                          : automaticCashGatewayBusy
                            ? "Occupato"
                            : automaticCashGatewayAvailable
                              ? "In ascolto"
                              : "Non raggiungibile"}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="payments-section payments-methods-section">
                  <div className="payments-section-head">
                    <strong>Metodi di pagamento</strong>
                  </div>

                  <div className="payments-method-list">
                    <div className="payments-method-row">
                      <div className="payments-method-row-copy">
                        <strong>Contanti</strong>
                        {hasAutoCashFloat ? (
                          <span>Fondo cassa automatico configurato.</span>
                        ) : hasManualCashFloat ? (
                          <span>Fondo cassa manuale: {formatCurrency(cashFloat ?? 0)}</span>
                        ) : (
                          <span>Carica il fondo cassa per abilitare i contanti.</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="smallbtn payments-cash-action-btn is-load payments-method-row-action"
                        disabled={hasLoadedCashFloat}
                        title={
                          hasLoadedCashFloat ? "Fondo cassa gia caricato" : "Carica fondo cassa"
                        }
                        onClick={openCashLoadChoice}
                      >
                        {hasLoadedCashFloat ? "Caricato" : "Carica"}
                      </button>
                    </div>

                    <div className="payments-method-row">
                      <div className="payments-method-row-copy">
                        <strong>Carta</strong>
                        <span>
                          {posTerminalsLoading
                            ? "Caricamento terminali..."
                            : hasPos
                              ? `POS attivo: ${selectedPosLabel}`
                              : "Seleziona il POS da usare."}
                        </span>
                      </div>
                      <GlassDropdown
                        value={posId ?? ""}
                        ariaLabel="Seleziona POS"
                        options={posOptions}
                        className="payments-pos-select payments-method-row-action"
                        onChange={(value) => {
                          setPosId(value || null);
                        }}
                      />
                    </div>

                    <div className="payments-method-row payments-counter-preference-row">
                      <div className="payments-method-row-copy">
                        <strong>Banco</strong>
                        <span>Metodo contanti predefinito per gli incassi in modalita Banco.</span>
                      </div>
                      <div
                        className="settings-segment payments-counter-preference-segment"
                        role="group"
                        aria-label="Metodo contanti predefinito per Banco"
                      >
                        <button
                          className={`settings-segment-btn ${counterCashSource === "wallet" ? "is-active" : ""}`}
                          type="button"
                          disabled={counterCashSaving}
                          onClick={() => updateCounterCashSource("wallet")}
                        >
                          Borsellino
                        </button>
                        <button
                          className={`settings-segment-btn ${counterCashSource === "automatic" ? "is-active" : ""}`}
                          type="button"
                          disabled={counterCashSaving}
                          onClick={() => updateCounterCashSource("automatic")}
                        >
                          Cassa automatica
                        </button>
                      </div>
                    </div>
                  </div>

                  {posTerminalsError && (
                    <div className="payments-alert is-warning">{posTerminalsError}</div>
                  )}
                  {counterCashError && (
                    <div className="payments-alert is-warning">{counterCashError}</div>
                  )}
                  {!paymentsEnabled && (
                    <div className="payments-alert is-warning">
                      Pagamenti disabilitati: inserisci un POS o conferma il fondo cassa contanti.
                    </div>
                  )}
                  {hasPos && !hasCashFloat && (
                    <div className="payments-alert is-warning">
                      POS presente ma fondo cassa non confermato: i contanti non sono disponibili.
                    </div>
                  )}
                </div>

                <div className="payments-section payments-operations-section">
                  <div className="payments-section-head">
                    <strong>Funzioni Cassa Automatica</strong>
                  </div>

                  <div className="payments-cash-action-grid">
                    <button
                      type="button"
                      className="smallbtn payments-cash-action-btn is-admin"
                      disabled={!canOpenAutomaticCashFloatAction}
                      title={
                        automaticCashFloatDisabledReason ||
                        (canAttemptResumeAutomaticCashWorkflow
                          ? "Riprendi fondo cassa automatico"
                          : "Genera fondo cassa automatico")
                      }
                      onClick={openAdminAutoCashModal}
                    >
                      {automaticCashFloatActionLabel}
                    </button>
                    <button
                      type="button"
                      className="smallbtn payments-cash-action-btn is-exchange"
                      disabled={!canStartCashExchange}
                      title={cashExchangeDisabledReason || "Cambio denaro"}
                      onClick={openCashExchangeModal}
                    >
                      {canResumeCashExchange ? "RIPRENDI SCAMBIO" : "SCAMBIO CONTANTI"}
                    </button>
                    <button
                      type="button"
                      className="smallbtn payments-cash-action-btn is-restart"
                      disabled={!canRunGatewayMaintenance || gatewayCommandBusy !== ""}
                      title={gatewayMaintenanceDisabledReason || "Riavvia cassa automatica"}
                      onClick={() => setGatewayCommandConfirm("restart")}
                    >
                      {gatewayCommandBusy === "restart" ? "RIAVVIO..." : "RIAVVIA CASSA"}
                    </button>
                    <button
                      type="button"
                      className="smallbtn payments-cash-action-btn is-reset"
                      disabled={!canRunGatewayMaintenance || gatewayCommandBusy !== ""}
                      title={gatewayMaintenanceDisabledReason || "Reset cassa automatica"}
                      onClick={() => setGatewayCommandConfirm("reset")}
                    >
                      {gatewayCommandBusy === "reset" ? "RESET..." : "RESET CASSA"}
                    </button>
                  </div>

                  <div className="payments-cash-movement-section">
                    <div className="payments-cash-movement-title">
                      <strong>Movimenti cassa</strong>
                      <span>Registra reintegri e prelievi con giustificazione.</span>
                    </div>
                    <div className="payments-cash-movement-actions">
                      <button
                        type="button"
                        className="smallbtn payments-cash-action-btn is-cash-load"
                        disabled={!canOpenCashMovement("load")}
                        title={cashMovementDisabledReason("load") || "Caricamento contanti"}
                        onClick={() => openCashMovementModal("load")}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 4v12" />
                          <path d="m7 11 5 5 5-5" />
                          <path d="M5 20h14" />
                        </svg>
                        <span>
                          {activeCashMovement?.type === "load"
                            ? "RIPRENDI CARICAMENTO"
                            : "CARICAMENTO"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="smallbtn payments-cash-action-btn is-cash-withdrawal"
                        disabled={!canOpenCashMovement("withdrawal")}
                        title={cashMovementDisabledReason("withdrawal") || "Prelievo contanti"}
                        onClick={() => openCashMovementModal("withdrawal")}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 20V8" />
                          <path d="m7 13 5-5 5 5" />
                          <path d="M5 4h14" />
                        </svg>
                        <span>
                          {activeCashMovement?.type === "withdrawal"
                            ? "RIPRENDI PRELIEVO"
                            : "PRELIEVO"}
                        </span>
                      </button>
                    </div>
                  </div>

                  {gatewayCommandError ? (
                    <div className="payments-note payments-cash-exchange-note is-error">
                      {gatewayCommandError}
                    </div>
                  ) : gatewayCommandMessage ? (
                    <div className="payments-note payments-cash-exchange-note is-success">
                      {gatewayCommandMessage}
                    </div>
                  ) : null}

                  {canAttemptResumeAutomaticCashWorkflow ? (
                    <div className="payments-note payments-cash-exchange-note">
                      Procedura fondo cassa pronta da riprendere.
                    </div>
                  ) : hasBlockingAutomaticCashWorkflow && automaticCashFloatDisabledReason ? (
                    <div className="payments-note payments-cash-exchange-note">
                      {automaticCashFloatDisabledReason}
                    </div>
                  ) : automaticCashGatewayDisabledReason ? (
                    <div className="payments-note payments-cash-exchange-note">
                      {automaticCashGatewayDisabledReason}
                    </div>
                  ) : cashExchangeDisabledReason ? (
                    <div className="payments-note payments-cash-exchange-note">
                      {cashExchangeDisabledReason}
                    </div>
                  ) : null}
                </div>

                {showSettlementSection && (
                  <Suspense fallback={<PaymentSettlementFallback />}>
                    <PaymentSettlementSection
                      cashDraft={cashDraft}
                      automaticGatewayOperational={gatewayOperational}
                      onRequestNewAutoCashFloat={openOperatorAutoCashModal}
                    />
                  </Suspense>
                )}
              </div>
            </div>
          </GlassCard>

          <CashFloatLoadChoiceModal
            open={cashLoadChoiceOpen}
            onClose={closeCashLoadChoice}
            onAutomatic={openOperatorAutoCashModal}
            onManual={openManualCashModal}
            automaticDisabled={!automaticCashGatewayAvailable}
            automaticDisabledReason={automaticCashGatewayDisabledReason}
          />

          <ManualCashFloatModal
            open={cashConfirmOpen}
            cashDraft={cashDraft}
            cashFloat={cashFloat}
            cashFloatLocked={cashFloatLocked}
            onCashDraftChange={setCashDraft}
            onClose={closeCashConfirm}
            onConfirm={confirmManualCashFloat}
          />

          <AutomaticCashFloatModal
            open={autoCashModalOpen}
            mode={autoCashModalMode}
            configured={hasAutoCashFloat}
            canAdminAutoCash={canAdminAutoCash}
            reason={
              autoCashModalMode === "admin-create"
                ? "admin_manual_generation"
                : "operator_cash_float"
            }
            operatorName={operatorName}
            token={token}
            userId={userId}
            username={username}
            fullName={fullName}
            deviceUuid={deviceUuid}
            activityId={activityId}
            roomId={roomId}
            onClose={closeAutoCashModal}
            onStatusMessage={ignoreStatusMessage}
          />

          <CashExchangeWizard
            open={cashExchangeOpen}
            activeExchange={activeCashExchange}
            deviceUuid={effectiveDeviceUuid}
            activityId={activityId}
            roomId={roomId}
            onClose={closeCashExchangeModal}
            onCompleted={refreshCashExchangeRuntime}
          />

          <CashMovementModal
            open={cashMovementModalType !== null}
            type={
              cashMovementModalType ??
              (activeCashMovement?.type === "withdrawal" ? "withdrawal" : "load")
            }
            activeMovement={activeCashMovement}
            deviceUuid={effectiveDeviceUuid}
            activityId={activityId}
            roomId={roomId}
            roomName={roomName}
            onClose={closeCashMovementModal}
          />

          {gatewayCommandConfirm ? (
            <div
              className="payments-maintenance-confirm-backdrop"
              role="presentation"
              onClick={() => setGatewayCommandConfirm("")}
            >
              <section
                className={`payments-maintenance-confirm is-${gatewayCommandConfirm}`}
                role="dialog"
                aria-modal="true"
                aria-label={
                  gatewayCommandConfirm === "restart"
                    ? "Conferma riavvio cassa automatica"
                    : "Conferma reset cassa automatica"
                }
                onClick={(event) => event.stopPropagation()}
              >
                <header className="payments-maintenance-confirm-head">
                  <div>
                    <span>Cassa automatica</span>
                    <strong>
                      {gatewayCommandConfirm === "restart" ? "Riavvia cassa" : "Reset cassa"}
                    </strong>
                  </div>
                  <button
                    type="button"
                    className="smallbtn payments-maintenance-confirm-close"
                    onClick={() => setGatewayCommandConfirm("")}
                    aria-label="Chiudi"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 6l12 12" />
                      <path d="M18 6 6 18" />
                    </svg>
                  </button>
                </header>
                <p>
                  {gatewayCommandConfirm === "restart"
                    ? "Il riavvio va eseguito solo quando non ci sono operazioni contanti in corso."
                    : "Il reset azzera lo stato operativo della cassa automatica. Usalo solo dopo avere chiuso ogni operazione."}
                </p>
                <div className="payments-maintenance-confirm-actions">
                  <button
                    type="button"
                    className="smallbtn payments-maintenance-cancel"
                    onClick={() => setGatewayCommandConfirm("")}
                  >
                    Annulla
                  </button>
                  <button
                    type="button"
                    className={`smallbtn payments-maintenance-submit is-${gatewayCommandConfirm}`}
                    disabled={gatewayCommandBusy !== ""}
                    onClick={() => void runGatewayMaintenanceCommand(gatewayCommandConfirm)}
                  >
                    Conferma
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
