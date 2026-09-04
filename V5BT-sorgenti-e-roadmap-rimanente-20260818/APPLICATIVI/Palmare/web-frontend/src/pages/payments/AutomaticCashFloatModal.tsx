import { useCallback, useEffect, useMemo, useState } from "react";
import {
  confirmAutomaticCashFloatTicketInPouch,
  confirmAutomaticCashFloatRemoved,
  generateAutomaticCashFloat,
  getAutomaticCashPreflight,
  loadAutomaticCashFloatFromQr,
} from "../../api/automaticCash";
import { usePaymentSettingsStore } from "../../store/paymentSettingsStore";
import type {
  AutomaticCashActiveWorkflow,
  GenerateAutomaticCashFloatResponse,
  LoadAutomaticCashFloatFromQrResponse,
  AutomaticCashPreflight,
} from "../../types/automaticCash";
import { formatAutomaticCashError } from "../../utils/automaticCashErrors";
import { saveAutomaticCashTicketRecord } from "../../utils/automaticCashTicketRegistry";
import backIconSrc from "../../assets/icons/indietro.png";
import {
  buildAutomaticCashFloatTicketText,
  type CashFloatTicket,
  type CashFloatTicketPrintAuth,
} from "./cashFloatTicket";
import { CashFloatTicketModal } from "./CashFloatTicketModal";
import { QrCameraScanner } from "./QrCameraScanner";
import { normalizeQrPayload } from "./qrPayload";

type AutomaticCashStep = "menu" | "approach" | "generating" | "confirm-removed" | "qr" | "loaded";
type AutomaticCashModalMode = "operator-load" | "admin-create";

type AutomaticCashFloatModalProps = {
  open: boolean;
  mode: AutomaticCashModalMode;
  configured: boolean;
  canAdminAutoCash: boolean;
  reason?: string;
  operatorName: string;
  token: string | null;
  userId: string | null;
  username?: string | null;
  fullName?: string | null;
  deviceUuid: string | null;
  activityId?: string | null;
  roomId?: string | null;
  onClose: () => void;
  onStatusMessage: (message: string) => void;
};

function ticketFromGenerated(
  response: GenerateAutomaticCashFloatResponse,
  operatorName: string
): CashFloatTicket {
  const base = {
    workflowId: response.workflowId,
    operationId: response.operationId,
    cashFloatId: response.cashFloatId,
    assignmentId: response.assignmentId,
    combinationId: response.combinationId,
    businessEveningKey: response.businessEveningKey,
    createdAtMs: response.createdAtMs,
    operatorName,
    totalCents: response.totalCents,
    qrPayload: response.qrPayload,
  };
  return {
    ...base,
    printText: buildAutomaticCashFloatTicketText(base),
  };
}

function ticketFromLoadedQr(
  response: LoadAutomaticCashFloatFromQrResponse,
  qrPayload: string,
  operatorName: string
): CashFloatTicket {
  const base = {
    cashFloatId: response.cashFloatId,
    assignmentId: response.assignmentId,
    combinationId: response.combinationId,
    businessEveningKey: response.businessEveningKey,
    createdAtMs: response.createdAtMs,
    operatorName,
    totalCents: response.totalCents,
    qrPayload: response.qrPayload || qrPayload,
  };
  return {
    ...base,
    printText: buildAutomaticCashFloatTicketText(base),
  };
}

function generatedFromActiveWorkflow(
  workflow: AutomaticCashActiveWorkflow | null | undefined
): GenerateAutomaticCashFloatResponse | null {
  if (!workflow) return null;
  const operationId = String(workflow.operationId ?? "").trim();
  const assignmentId = String(workflow.assignmentId ?? "").trim();
  const combinationId = String(workflow.combinationId ?? "").trim();
  const businessEveningKey = String(workflow.businessEveningKey ?? "").trim();
  const configSetId = String(workflow.configSetId ?? "").trim();
  const qrPayload = String(workflow.qrPayload ?? "").trim();
  const totalCents = Number(workflow.totalCents);
  const createdAtMs = Number(workflow.createdAtMs ?? workflow.startedAtMs);
  if (
    !workflow.workflowId ||
    !operationId ||
    !workflow.cashFloatId ||
    !assignmentId ||
    !combinationId ||
    !businessEveningKey ||
    !configSetId ||
    !qrPayload ||
    !Number.isFinite(totalCents) ||
    !Number.isFinite(createdAtMs)
  ) {
    return null;
  }
  return {
    ok: true,
    resumed: true,
    workflowId: workflow.workflowId,
    operationId,
    cashFloatId: workflow.cashFloatId,
    assignmentId,
    combinationId,
    businessEveningKey,
    configSetId,
    reserveConfigId: workflow.reserveConfigId ?? null,
    pieces: workflow.pieces ?? {},
    totalCents,
    createdAtMs,
    qrPayload,
    step: workflow.step,
  };
}

export function AutomaticCashFloatModal({
  open,
  mode,
  configured,
  canAdminAutoCash,
  reason = "operator_cash_float",
  operatorName,
  token,
  userId,
  username,
  fullName,
  deviceUuid,
  activityId,
  roomId,
  onClose,
  onStatusMessage,
}: AutomaticCashFloatModalProps) {
  const lockAutoCashFloat = usePaymentSettingsStore((state) => state.lockAutoCashFloat);
  const [step, setStep] = useState<AutomaticCashStep>("menu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [generated, setGenerated] = useState<GenerateAutomaticCashFloatResponse | null>(null);
  const [ticket, setTicket] = useState<CashFloatTicket | null>(null);
  const [preflight, setPreflight] = useState<AutomaticCashPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [ticketConfirming, setTicketConfirming] = useState(false);
  const [ticketError, setTicketError] = useState("");
  const shouldLoadGeneratedCashFloat = mode === "operator-load";

  const openGeneratedWorkflow = useCallback(
    (
      response: GenerateAutomaticCashFloatResponse,
      workflowStep: AutomaticCashActiveWorkflow["step"] | undefined,
      source: "auto" | "manual" = "manual"
    ) => {
      setGenerated(response);
      setError("");
      setTicketError("");
      if (workflowStep === "TICKET_READY" || workflowStep === "PRINTING_TICKET") {
        const nextTicket = ticketFromGenerated(response, operatorName);
        saveAutomaticCashTicketRecord({ ...nextTicket, status: "generated" });
        setTicket(nextTicket);
        setStep("confirm-removed");
        onStatusMessage("Creazione fondo cassa ripresa. Scontrino pronto.");
        return true;
      }
      if (workflowStep === "WAITING_TICKET_IN_POUCH") {
        const nextTicket = { ...ticketFromGenerated(response, operatorName), autoPrint: false };
        saveAutomaticCashTicketRecord({ ...nextTicket, status: "generated" });
        setTicket(nextTicket);
        setStep("confirm-removed");
        onStatusMessage("Creazione fondo cassa ripresa. Conferma lo scontrino nel borsellino.");
        return true;
      }
      if (workflowStep === "WAITING_CASH_REMOVAL" || workflowStep === "CASH_REMOVED_CONFIRMED") {
        setTicket(null);
        setStep("confirm-removed");
        onStatusMessage("Creazione fondo cassa ripresa. Conferma il ritiro.");
        return true;
      }
      setTicket(null);
      setStep("generating");
      if (source === "manual") {
        onStatusMessage("Creazione fondo cassa ripresa.");
      }
      return true;
    },
    [operatorName, onStatusMessage]
  );

  const resumeActiveWorkflow = useCallback(
    (
      workflow: AutomaticCashActiveWorkflow | null | undefined,
      source: "auto" | "manual" = "manual"
    ) => {
      const response = generatedFromActiveWorkflow(workflow);
      if (!response) return false;
      return openGeneratedWorkflow(response, workflow?.step, source);
    },
    [openGeneratedWorkflow]
  );

  useEffect(() => {
    if (!open) return;
    setStep("menu");
    setBusy(false);
    setError("");
    setGenerated(null);
    setTicket(null);
    setPreflight(null);
    setTicketError("");
    setPreflightLoading(true);
    void getAutomaticCashPreflight()
      .then((nextPreflight) => {
        setPreflight(nextPreflight);
        if (nextPreflight.activeWorkflow?.resumableByCurrentUser) {
          resumeActiveWorkflow(nextPreflight.activeWorkflow, "auto");
        }
      })
      .catch((caught) => {
        setPreflight(null);
        setError(formatAutomaticCashError(caught, "Preflight fondo cassa non riuscito."));
      })
      .finally(() => setPreflightLoading(false));
  }, [open, resumeActiveWorkflow]);

  const printAuth = useMemo<CashFloatTicketPrintAuth>(
    () => ({ token, userId, username, fullName, deviceUuid, activityId, roomId }),
    [activityId, deviceUuid, fullName, roomId, token, userId, username]
  );

  if (!open) return null;

  const applyGeneratedResponse = (response: GenerateAutomaticCashFloatResponse) => {
    lockAutoCashFloat({
      id: response.cashFloatId,
      value: response.totalCents / 100,
      qrPayload: response.qrPayload,
      createdAtMs: response.createdAtMs,
      assignmentId: response.assignmentId,
      combinationId: response.combinationId,
      businessEveningKey: response.businessEveningKey,
    });
  };

  const applyQrResponse = (response: LoadAutomaticCashFloatFromQrResponse, qrPayload: string) => {
    lockAutoCashFloat({
      id: response.cashFloatId,
      value: response.totalCents / 100,
      qrPayload: response.qrPayload || qrPayload,
      createdAtMs: response.createdAtMs,
      assignmentId: response.assignmentId,
      combinationId: response.combinationId,
      businessEveningKey: response.businessEveningKey,
    });
  };

  const createNew = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setStep("generating");
    try {
      const response = await generateAutomaticCashFloat({
        deviceUuid: deviceUuid ?? undefined,
        activityId: activityId ?? undefined,
        roomId: roomId ?? undefined,
        reason,
        preferExistingAssignmentForEvening: true,
      });
      if (response.resumed) {
        openGeneratedWorkflow(response, response.step, "manual");
      } else {
        setGenerated(response);
        setStep("confirm-removed");
      }
    } catch (caught) {
      setError(formatAutomaticCashError(caught));
      setStep("menu");
    } finally {
      setBusy(false);
    }
  };

  const confirmRemoved = async () => {
    if (!generated || busy) return;
    setBusy(true);
    setError("");
    try {
      await confirmAutomaticCashFloatRemoved({
        workflowId: generated.workflowId,
        operationId: generated.operationId,
        cashFloatId: generated.cashFloatId,
      });
      const nextTicket = ticketFromGenerated(generated, operatorName);
      saveAutomaticCashTicketRecord({ ...nextTicket, status: "generated" });
      setTicket(nextTicket);
      onStatusMessage("Scontrino fondo cassa pronto. Conferma inserimento nel borsellino.");
    } catch (caught) {
      setError(formatAutomaticCashError(caught));
    } finally {
      setBusy(false);
    }
  };

  const loadQrPayload = async (rawPayload: string) => {
    const qrPayload = normalizeQrPayload(rawPayload);
    if (!qrPayload) {
      setError("QR fondo cassa non letto dalla videocamera.");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await loadAutomaticCashFloatFromQr({
        qrPayload,
        deviceUuid: deviceUuid ?? undefined,
      });
      applyQrResponse(response, qrPayload);
      const loadedTicket = ticketFromLoadedQr(response, qrPayload, operatorName);
      saveAutomaticCashTicketRecord({ ...loadedTicket, status: "loaded" });
      setStep("loaded");
      onStatusMessage("Fondo cassa automatico caricato. Puoi procedere con le transazioni.");
    } catch (caught) {
      setError(formatAutomaticCashError(caught));
    } finally {
      setBusy(false);
    }
  };

  const closeTicket = () => setTicket(null);

  const finishTicketFlow = async () => {
    if (!generated || ticketConfirming) return;
    setTicketConfirming(true);
    setTicketError("");
    try {
      const response = await confirmAutomaticCashFloatTicketInPouch({
        workflowId: generated.workflowId,
        cashFloatId: generated.cashFloatId,
        confirmedAtMs: Date.now(),
        loadAsActiveCashFloat: shouldLoadGeneratedCashFloat,
      });
      if (shouldLoadGeneratedCashFloat) {
        applyGeneratedResponse({
          ...generated,
          totalCents: response.totalCents || generated.totalCents,
          qrPayload: response.qrPayload || generated.qrPayload,
        });
      }
      setTicket(null);
      onStatusMessage(
        shouldLoadGeneratedCashFloat
          ? "Fondo cassa automatico configurato."
          : "Fondo cassa automatico creato. Scontrino inserito nel borsellino."
      );
      onClose();
    } catch (caught) {
      setTicketError(formatAutomaticCashError(caught));
    } finally {
      setTicketConfirming(false);
    }
  };

  const resumableWorkflow = preflight?.activeWorkflow?.resumableByCurrentUser
    ? preflight.activeWorkflow
    : preflight?.activeWorkflow &&
        ((userId && preflight.activeWorkflow.ownerUserId === userId) ||
          (canAdminAutoCash &&
            preflight.activeWorkflow.operationLock?.ownerCanManageAutomaticCash !== true))
      ? preflight.activeWorkflow
      : null;
  const title = resumableWorkflow
    ? "Riprendi FC"
    : mode === "admin-create"
      ? "Genera FC"
      : "Fondo cassa automatico";
  const canResumeActiveWorkflow =
    Boolean(resumableWorkflow) && !preflightLoading && !busy;
  const canCreateNew = Boolean(preflight?.canCreate) && !preflightLoading && !busy;
  const canReturnToAutoCashMenu = step === "approach" || step === "qr";
  const returnToAutoCashMenu = () => {
    if (busy) return;
    setError("");
    setStep("menu");
  };

  return (
    <>
      <div className="payments-confirm-backdrop" onClick={busy ? undefined : onClose}>
        <div
          className="payments-confirm-card payments-auto-card"
          role="dialog"
          aria-modal="true"
          aria-label="Fondo cassa automatico"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="payments-confirm-head payments-confirm-head-balanced">
            {canReturnToAutoCashMenu ? (
              <button
                type="button"
                className="smallbtn payments-confirm-back"
                onClick={returnToAutoCashMenu}
                aria-label="Indietro"
                disabled={busy}
              >
                <img
                  className="payments-confirm-back-icon"
                  src={backIconSrc}
                  alt=""
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span className="payments-confirm-head-spacer" aria-hidden="true" />
            )}
            <strong>{title}</strong>
            <button
              type="button"
              className="smallbtn payments-confirm-close"
              onClick={onClose}
              aria-label="Chiudi"
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </button>
          </div>

          <div className="payments-confirm-body">
            {mode === "operator-load" && configured && step === "menu" ? (
              <div className="payments-lock payments-auto-state">
                <strong>Fondo cassa automatico configurato</strong>
              </div>
            ) : null}

            {step === "menu" && (
              <>
                <div className="payments-auto-state">
                  <strong>
                    {mode === "admin-create" ? "Genera FC" : "Preparazione automatica"}
                  </strong>
                  <span>
                    {resumableWorkflow
                      ? "Riprendi la creazione fondo cassa automatica gia avviata."
                      : mode === "admin-create"
                        ? "Crea un nuovo fondo cassa automatico senza caricarlo su questa postazione."
                        : "Carica un fondo cassa automatico da QR o creane uno nuovo."}
                  </span>
                </div>
                <div
                  className={`payments-actions payments-auto-actions ${
                    mode === "admin-create" ? "is-single" : ""
                  }`}
                >
                  {mode === "operator-load" ? (
                    <button
                      type="button"
                      className="smallbtn payments-confirm"
                      onClick={() => setStep("qr")}
                      disabled={busy}
                    >
                      Carica
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={
                      mode === "admin-create"
                        ? "smallbtn payments-confirm"
                        : "smallbtn payments-auto-secondary"
                    }
                    onClick={() => {
                      if (resumableWorkflow) {
                        if (!resumeActiveWorkflow(resumableWorkflow, "manual")) {
                          void createNew();
                        }
                      } else {
                        setStep("approach");
                      }
                    }}
                    disabled={resumableWorkflow ? !canResumeActiveWorkflow : !canCreateNew}
                  >
                    {resumableWorkflow ? "Riprendi" : "Nuovo"}
                  </button>
                </div>
                {mode === "operator-load" && canAdminAutoCash && (
                  <div className="payments-note">Accesso Genera FC admin disponibile.</div>
                )}
                {preflightLoading ? (
                  <div className="payments-note">Verifica inventario cassa automatica...</div>
                ) : preflight && !preflight.canCreate && !resumableWorkflow ? (
                  <div className="payments-alert is-warning">
                    {preflight.message || "Creazione fondo cassa non disponibile."}
                  </div>
                ) : null}
              </>
            )}

            {step === "approach" && (
              <>
                <div className="payments-auto-state">
                  <strong>Avvicinati alla cassa automatica</strong>
                  <span>Conferma quando sei pronto per avviare l'erogazione.</span>
                </div>
                <div className="payments-actions payments-auto-actions is-single">
                  <button
                    type="button"
                    className="smallbtn payments-confirm"
                    onClick={createNew}
                    disabled={busy}
                  >
                    Avvia erogazione
                  </button>
                </div>
              </>
            )}

            {step === "generating" && (
              <div className="payments-auto-state">
                <strong>Erogazione in corso</strong>
                <span>Attendi la risposta della cassa automatica.</span>
              </div>
            )}

            {step === "confirm-removed" && (
              <>
                <div className="payments-auto-state">
                  <strong>Denaro erogato</strong>
                  <span>Hai caricato tutto nel borsellino?</span>
                </div>
                <button
                  type="button"
                  className="smallbtn payments-confirm"
                  onClick={confirmRemoved}
                  disabled={busy}
                >
                  {busy ? "Conferma..." : "Conferma ritiro"}
                </button>
              </>
            )}

            {step === "qr" && (
              <>
                <div className="payments-qr-title">Scansiona QR</div>
                <QrCameraScanner
                  active={step === "qr"}
                  disabled={busy}
                  onDetected={(payload) => {
                    void loadQrPayload(payload);
                  }}
                  onError={(message) => setError(message)}
                />
              </>
            )}

            {step === "loaded" && (
              <>
                <div className="payments-lock payments-auto-state">
                  <strong>Fondo cassa automatico caricato</strong>
                  <span>Puoi procedere con le transazioni.</span>
                </div>
                <button type="button" className="smallbtn payments-confirm" onClick={onClose}>
                  Chiudi
                </button>
              </>
            )}

            {error && <div className="payments-alert is-error">{error}</div>}
          </div>
        </div>
      </div>

      <CashFloatTicketModal
        ticket={ticket}
        auth={printAuth}
        onClose={closeTicket}
        onInserted={finishTicketFlow}
        insertBusy={ticketConfirming}
        insertError={ticketError}
      />
    </>
  );
}
