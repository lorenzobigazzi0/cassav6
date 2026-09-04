import { useEffect, useMemo, useState } from "react";
import {
  cancelCashExchange,
  confirmCashExchangeDeposit,
  confirmCashExchangeRemoved,
  executeCashExchange,
  getCashExchangeState,
  startCashExchange,
} from "../../api/cashExchange";
import { formatCurrency } from "../../shared/format/currency";
import type {
  ActiveCashExchange,
  CashExchangePieces,
  CashExchangeState,
  CashExchangeStatus,
  CashExchangeStep,
  CashExchangeAvailableDenomination,
} from "../../types/cashExchange";
import { formatAutomaticCashError } from "../../utils/automaticCashErrors";
import { CashExchangeDenominationSelector } from "./CashExchangeDenominationSelector";
import {
  canRepresentCashExchangeAmount,
  normalizeCashExchangePieces,
  sumCashExchangePieces,
} from "./cashExchangeDenominations";

type CashExchangeWizardProps = {
  open: boolean;
  activeExchange?: ActiveCashExchange | null;
  deviceUuid?: string | null;
  activityId?: string | null;
  roomId?: string | null;
  onClose: () => void;
  onCompleted?: () => void;
};

const POLL_INTERVAL_MS = 1250;

const formatCents = (value: number) => formatCurrency(Math.max(0, Math.trunc(value)) / 100);

function statusToStep(status: CashExchangeStatus): CashExchangeStep {
  if (status === "DEPOSIT_STARTED" || status === "DEPOSITING" || status === "CREATED") {
    return "depositing";
  }
  if (status === "CHANGE_STARTED") return "depositing";
  if (status === "DEPOSIT_CONFIRMED" || status === "SELECTING_DENOMINATIONS") {
    return "selectDenominations";
  }
  if (
    status === "CHANGE_REQUESTED" ||
    status === "WAITING_CHANGE_REMOVAL" ||
    status === "WITHDRAWAL_STARTED" ||
    status === "WAITING_CASH_REMOVAL"
  ) {
    return "waitingChangeRemoval";
  }
  if (status === "COMPLETED") return "completed";
  if (status === "CANCELLED") return "cancelled";
  if (status === "FAILED") return "failed";
  return "approach";
}

function applyState(
  state: CashExchangeState,
  setters: {
    setExchangeId: (value: string) => void;
    setDepositedCents: (value: number) => void;
    setPieces: (value: CashExchangePieces) => void;
    setAllowedDenominations: (value: number[]) => void;
    setAvailableDenominations: (value: CashExchangeAvailableDenomination[]) => void;
    setStep: (value: CashExchangeStep) => void;
  }
) {
  setters.setExchangeId(state.exchangeId);
  setters.setDepositedCents(Math.max(0, Math.trunc(state.depositedCents || 0)));
  if (state.selectedPieces) setters.setPieces(normalizeCashExchangePieces(state.selectedPieces));
  if (state.allowedDenominationsCents?.length) {
    setters.setAllowedDenominations(state.allowedDenominationsCents);
  }
  if (state.availableDenominations) {
    setters.setAvailableDenominations(state.availableDenominations);
  }
  setters.setStep(statusToStep(state.status));
}

export function CashExchangeWizard({
  open,
  activeExchange = null,
  deviceUuid,
  activityId,
  roomId,
  onClose,
  onCompleted,
}: CashExchangeWizardProps) {
  const [step, setStep] = useState<CashExchangeStep>("approach");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exchangeId, setExchangeId] = useState("");
  const [depositedCents, setDepositedCents] = useState(0);
  const [pieces, setPieces] = useState<CashExchangePieces>({});
  const [allowedDenominations, setAllowedDenominations] = useState<number[]>([]);
  const [availableDenominations, setAvailableDenominations] = useState<
    CashExchangeAvailableDenomination[]
  >([]);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError("");
    setAllowedDenominations([]);
    setAvailableDenominations([]);
    if (activeExchange) {
      setExchangeId(activeExchange.exchangeId);
      setDepositedCents(Math.max(0, Math.trunc(activeExchange.depositedCents || 0)));
      setPieces(normalizeCashExchangePieces(activeExchange.selectedPieces || {}));
      setAvailableDenominations(activeExchange.availableDenominations || []);
      setStep(statusToStep(activeExchange.status));
      return;
    }
    setExchangeId("");
    setDepositedCents(0);
    setPieces({});
    setStep("approach");
  }, [activeExchange, open]);

  useEffect(() => {
    if (!open || !exchangeId || step !== "depositing") return;
    let alive = true;

    const pollState = async () => {
      try {
        const state = await getCashExchangeState(exchangeId);
        if (!alive) return;
        applyState(state, {
          setExchangeId,
          setDepositedCents,
          setPieces,
          setAllowedDenominations,
          setAvailableDenominations,
          setStep,
        });
      } catch (caught) {
        if (alive)
          setError(formatAutomaticCashError(caught, "Lettura deposito cambio non riuscita."));
      }
    };

    void pollState();
    const timer = window.setInterval(() => void pollState(), POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [exchangeId, open, step]);

  const selectedTotalCents = useMemo(() => sumCashExchangePieces(pieces), [pieces]);
  const remainingCents = Math.max(0, depositedCents - selectedTotalCents);
  const canConfirmPieces =
    depositedCents > 0 &&
    canRepresentCashExchangeAmount(depositedCents) &&
    selectedTotalCents === depositedCents;

  if (!open) return null;

  const closeFlow = () => {
    if (busy) return;
    onClose();
  };

  const cancelFlow = async () => {
    if (busy) return;
    if (!exchangeId || step === "approach" || step === "completed" || step === "cancelled") {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await cancelCashExchange(exchangeId);
      setStep("cancelled");
      onClose();
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Annullamento cambio non riuscito."));
    } finally {
      setBusy(false);
    }
  };

  const startDeposit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setStep("startingDeposit");
    try {
      const state = await startCashExchange({
        deviceUuid: deviceUuid || undefined,
        activityId: activityId || undefined,
        roomId: roomId || undefined,
      });
      applyState(state, {
        setExchangeId,
        setDepositedCents,
          setPieces,
          setAllowedDenominations,
          setAvailableDenominations,
          setStep,
        });
    } catch (caught) {
      setStep("approach");
      setError(formatAutomaticCashError(caught, "Avvio cambio non riuscito."));
    } finally {
      setBusy(false);
    }
  };

  const requestDepositConfirmation = () => {
    if (depositedCents <= 0) {
      setError("Inserisci il denaro da cambiare prima di confermare.");
      return;
    }
    if (!canRepresentCashExchangeAmount(depositedCents)) {
      setError("Importo non rappresentabile con i tagli disponibili.");
      return;
    }
    setError("");
    setStep("confirmDeposit");
  };

  const confirmDeposit = async () => {
    if (!exchangeId || busy) return;
    setBusy(true);
    setError("");
    try {
      const state = await confirmCashExchangeDeposit(exchangeId);
      applyState(state, {
        setExchangeId,
        setDepositedCents,
          setPieces,
          setAllowedDenominations,
          setAvailableDenominations,
          setStep,
        });
      setPieces({});
      setStep("selectDenominations");
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Conferma deposito cambio non riuscita."));
    } finally {
      setBusy(false);
    }
  };

  const executeChange = async () => {
    if (!exchangeId || busy || !canConfirmPieces) return;
    setBusy(true);
    setError("");
    setStep("executingChange");
    try {
      const normalizedPieces = normalizeCashExchangePieces(pieces);
      await executeCashExchange(exchangeId, normalizedPieces);
      setPieces(normalizedPieces);
      setStep("waitingChangeRemoval");
    } catch (caught) {
      setStep("selectDenominations");
      setError(formatAutomaticCashError(caught, "Erogazione cambio non riuscita."));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemoved = async () => {
    if (!exchangeId || busy) return;
    setBusy(true);
    setError("");
    try {
      await confirmCashExchangeRemoved(exchangeId);
      setStep("completed");
      onCompleted?.();
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Conferma ritiro cambio non riuscita."));
    } finally {
      setBusy(false);
    }
  };

  const allowedCopy = allowedDenominations.length
    ? `${allowedDenominations.length} tagli abilitati dal backend.`
    : "Tagli standard disponibili.";
  const availabilityCopy = availableDenominations.length
    ? "Pezzi erogabili aggiornati dalla cassa automatica."
    : allowedCopy;

  return (
    <div className="payments-confirm-backdrop cash-exchange-backdrop">
      <section
        className="payments-confirm-card payments-auto-card cash-exchange-card"
        role="dialog"
        aria-modal="true"
        aria-label="Cambio denaro"
      >
        <div className="payments-confirm-head payments-confirm-head-balanced">
          <span className="payments-confirm-head-spacer" aria-hidden="true" />
          <strong>Cambio</strong>
          <button
            type="button"
            className="smallbtn payments-confirm-close"
            aria-label="Chiudi cambio"
            disabled={busy}
            onClick={() => void cancelFlow()}
          >
            X
          </button>
        </div>

        <div className="payments-confirm-body cash-exchange-body">
          {step === "approach" ? (
            <div className="payments-auto-state">
              <strong>Avvicinati alla cassa automatica</strong>
              <span>Premi conferma solo quando sei davanti alla macchina.</span>
            </div>
          ) : null}

          {step === "startingDeposit" ? (
            <div className="payments-auto-state">
              <strong>Avvio deposito</strong>
              <span>Attendi la risposta della cassa automatica.</span>
            </div>
          ) : null}

          {step === "depositing" ? (
            <>
              <div className="payments-auto-state cash-exchange-live-total">
                <span>Totale caricato</span>
                <strong>{formatCents(depositedCents)}</strong>
              </div>
              <div className="payments-auto-state">
                <strong>Inserisci il denaro da cambiare</strong>
                <span>Il totale viene aggiornato automaticamente.</span>
              </div>
            </>
          ) : null}

          {step === "confirmDeposit" ? (
            <div className="payments-auto-state">
              <strong>Hai inserito tutto il denaro da cambiare?</strong>
              <span>Totale caricato: {formatCents(depositedCents)}</span>
            </div>
          ) : null}

          {step === "selectDenominations" ? (
            <>
              <div className="payments-auto-state">
                <strong>Scegli i tagli da erogare</strong>
                <span>{availabilityCopy}</span>
              </div>
              <CashExchangeDenominationSelector
                depositedCents={depositedCents}
                pieces={pieces}
                allowedDenominationsCents={allowedDenominations}
                availableDenominations={availableDenominations}
                disabled={busy}
                onChange={setPieces}
              />
            </>
          ) : null}

          {step === "executingChange" ? (
            <div className="payments-auto-state">
              <strong>Erogazione cambio</strong>
              <span>Attendi il completamento della cassa automatica.</span>
            </div>
          ) : null}

          {step === "waitingChangeRemoval" ? (
            <div className="payments-auto-state">
              <strong>Ritira il denaro erogato</strong>
              <span>Conferma solo dopo aver ritirato tutto il denaro.</span>
            </div>
          ) : null}

          {step === "completed" ? (
            <div className="payments-auto-state">
              <strong>Cambio completato</strong>
              <span>Operazione registrata correttamente.</span>
            </div>
          ) : null}

          {step === "cancelled" ? (
            <div className="payments-auto-state">
              <strong>Cambio annullato</strong>
              <span>La procedura e' stata chiusa.</span>
            </div>
          ) : null}

          {step === "failed" ? (
            <div className="payments-auto-state">
              <strong>Cambio non riuscito</strong>
              <span>Riapri la procedura o contatta un admin.</span>
            </div>
          ) : null}

          {step === "selectDenominations" ? (
            <div className="cash-exchange-residual-note">
              Residuo da assegnare: {formatCents(remainingCents)}
            </div>
          ) : null}

          {error ? (
            <div className="payments-alert is-warning cash-exchange-error">{error}</div>
          ) : null}
        </div>

        <div className="payments-auto-actions cash-exchange-actions">
          {step === "completed" || step === "cancelled" || step === "failed" ? (
            <button
              type="button"
              className="smallbtn payments-confirm cash-exchange-primary"
              onClick={closeFlow}
              disabled={busy}
            >
              Chiudi
            </button>
          ) : (
            <>
              <button
                type="button"
                className="smallbtn payments-confirm-back cash-exchange-secondary"
                onClick={() => void cancelFlow()}
                disabled={busy}
              >
                Annulla
              </button>
              <button
                type="button"
                className="smallbtn payments-confirm cash-exchange-primary"
                disabled={
                  busy ||
                  (step === "selectDenominations" && !canConfirmPieces) ||
                  (step === "confirmDeposit" && depositedCents <= 0)
                }
                onClick={() => {
                  if (step === "approach") void startDeposit();
                  if (step === "depositing") requestDepositConfirmation();
                  if (step === "confirmDeposit") void confirmDeposit();
                  if (step === "selectDenominations") void executeChange();
                  if (step === "waitingChangeRemoval") void confirmRemoved();
                }}
              >
                {busy
                  ? "Attendi..."
                  : step === "approach"
                    ? "Conferma"
                    : step === "depositing"
                      ? "Ho inserito tutto"
                      : step === "confirmDeposit"
                        ? "Conferma deposito"
                        : step === "selectDenominations"
                          ? "Conferma cambio"
                          : step === "waitingChangeRemoval"
                            ? "Ho ritirato tutto"
                            : "Conferma"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
