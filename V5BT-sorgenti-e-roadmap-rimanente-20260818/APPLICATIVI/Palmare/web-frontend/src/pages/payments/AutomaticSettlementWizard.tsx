import { useEffect, useMemo, useState } from "react";
import {
  cancelAutomaticCashDeposit,
  closeAutomaticCashDeposit,
  startAutomaticCashDeposit,
} from "../../api/automaticCash";
import { automaticCashFeedbackAssets } from "../../assets/feedback";
import { formatAutomaticCashError } from "../../utils/automaticCashErrors";
import {
  type AutomaticCashSettlementRecord,
  resolveSettlementFeedback,
  type SettlementFeedbackKind,
} from "../../utils/automaticCashSettlementArchive";
import {
  automaticSettlementDifferenceCents,
  automaticSettlementExpectedDepositTotalCents,
  type AutomaticSettlementContext,
} from "./automaticSettlementModel";

const WARNING_THRESHOLD_CENTS = 1000;
const DANGER_THRESHOLD_CENTS = 1000;

export type AutomaticSettlementResult = {
  operationId: string;
  expectedDepositTotalCents: number;
  depositedTotalCents: number;
  differenceCents: number;
  mismatchConfirmed: boolean;
  feedbackKind: SettlementFeedbackKind;
};

type AutomaticSettlementStep =
  | "approach"
  | "deposit"
  | "closing"
  | "review"
  | "completing"
  | "completed";

type AutomaticSettlementWizardProps = {
  open: boolean;
  loading?: boolean;
  context: AutomaticSettlementContext | null;
  feedbackEnabled?: boolean;
  warningThresholdCents?: number;
  dangerThresholdCents?: number;
  onClose: () => void;
  onCompleted: (result: AutomaticSettlementResult) => Promise<AutomaticCashSettlementRecord>;
  onReprint: (record: AutomaticCashSettlementRecord) => Promise<void>;
};

const toCents = (value: number) => Math.max(0, Math.round(value));
const formatCents = (value: number) =>
  (toCents(value) / 100).toLocaleString("it-IT", {
    style: "currency",
    currency: "EUR",
  });

function buildResult(input: {
  operationId: string;
  expectedDepositTotalCents: number;
  depositedTotalCents: number;
  mismatchConfirmed: boolean;
  warningThresholdCents: number;
  dangerThresholdCents: number;
}): AutomaticSettlementResult {
  const differenceCents = automaticSettlementDifferenceCents(
    input.expectedDepositTotalCents,
    input.depositedTotalCents
  );
  return {
    operationId: input.operationId,
    expectedDepositTotalCents: toCents(input.expectedDepositTotalCents),
    depositedTotalCents: toCents(input.depositedTotalCents),
    differenceCents,
    mismatchConfirmed: input.mismatchConfirmed,
    feedbackKind: resolveSettlementFeedback({
      expectedDepositTotalCents: input.expectedDepositTotalCents,
      depositedTotalCents: input.depositedTotalCents,
      warningThresholdCents: input.warningThresholdCents,
      dangerThresholdCents: input.dangerThresholdCents,
    }),
  };
}

export function AutomaticSettlementWizard({
  open,
  loading = false,
  context,
  feedbackEnabled = false,
  warningThresholdCents = WARNING_THRESHOLD_CENTS,
  dangerThresholdCents = DANGER_THRESHOLD_CENTS,
  onClose,
  onCompleted,
  onReprint,
}: AutomaticSettlementWizardProps) {
  const [step, setStep] = useState<AutomaticSettlementStep>("approach");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState("");
  const [pendingResult, setPendingResult] = useState<AutomaticSettlementResult | null>(null);
  const [completedRecord, setCompletedRecord] =
    useState<AutomaticCashSettlementRecord | null>(null);
  const [reprintBusy, setReprintBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("approach");
    setBusy(false);
    setError("");
    setOperationId("");
    setPendingResult(null);
    setCompletedRecord(null);
    setReprintBusy(false);
  }, [open]);

  const expectedDepositTotalCents = useMemo(
    () => (context ? automaticSettlementExpectedDepositTotalCents(context) : 0),
    [context]
  );

  if (!open) return null;

  const startDeposit = async () => {
    if (!context || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      const response = await startAutomaticCashDeposit({
        deviceUuid: context.deviceUuid ?? undefined,
        cashFloatId: context.cashFloatId ?? undefined,
      });
      setOperationId(response.operationId);
      setStep("deposit");
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Avvio scarico automatico non riuscito."));
    } finally {
      setBusy(false);
    }
  };

  const completeWithResult = async (result: AutomaticSettlementResult) => {
    setStep("completing");
    setBusy(true);
    setError("");
    try {
      const record = await onCompleted(result);
      setPendingResult(result);
      setCompletedRecord(record);
      setStep("completed");
    } catch (caught) {
      setStep("review");
      setError(caught instanceof Error ? caught.message : "Chiusura scarico non riuscita.");
    } finally {
      setBusy(false);
    }
  };

  const reprintCompletedReport = async () => {
    if (!completedRecord || busy || reprintBusy) return;
    setReprintBusy(true);
    setError("");
    try {
      await onReprint(completedRecord);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ristampa report scarico non riuscita.");
    } finally {
      setReprintBusy(false);
    }
  };

  const closeDeposit = async () => {
    if (!operationId || busy) return;
    setBusy(true);
    setStep("closing");
    setError("");
    try {
      const response = await closeAutomaticCashDeposit({ operationId });
      const result = buildResult({
        operationId,
        expectedDepositTotalCents,
        depositedTotalCents: response.depositedTotalCents,
        mismatchConfirmed: false,
        warningThresholdCents,
        dangerThresholdCents,
      });
      setPendingResult(result);
      setStep("review");
    } catch (caught) {
      setStep("deposit");
      setError(formatAutomaticCashError(caught, "Chiusura deposito non riuscita."));
    } finally {
      setBusy(false);
    }
  };

  const confirmAndPrint = async () => {
    if (!pendingResult || busy) return;
    await completeWithResult(pendingResult);
  };

  const cancelFlow = async () => {
    if (busy || reprintBusy) return;
    const activeOperationId = operationId.trim();
    if (step === "review" || step === "completing") return;
    if (activeOperationId && step === "deposit") {
      setBusy(true);
      await cancelAutomaticCashDeposit({ operationId: activeOperationId }).catch(() => undefined);
      setBusy(false);
    }
    onClose();
  };

  const feedbackAsset =
    pendingResult ? automaticCashFeedbackAssets[pendingResult.feedbackKind] : null;
  void feedbackEnabled;

  return (
    <div className="mobile-payments-settlement-backdrop" onPointerDown={cancelFlow}>
      <div
        className="mobile-payments-settlement-dialog automatic-settlement-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scarico automatico"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="mobile-payments-settlement-head">
          <strong>Scarico automatico</strong>
          <button
            type="button"
            className="smallbtn mobile-payments-settlement-close"
            onClick={cancelFlow}
            disabled={busy || reprintBusy || step === "review" || step === "completing"}
          >
            Chiudi
          </button>
        </div>

        <div className="mobile-payments-settlement-body">
          {loading || !context ? (
            <div className="mobile-payments-settlement-note">Preparazione scarico...</div>
          ) : null}

          {step === "approach" && context ? (
            <>
              <div className="payments-auto-state">
                <strong>Avvicinati alla cassa automatica</strong>
                <span>Conferma solo quando sei davanti alla cassa.</span>
              </div>
              <div className="mobile-payments-settlement-note">
                Verranno depositati tutti i contanti, compreso il fondo cassa caricato nel
                borsellino.
              </div>
            </>
          ) : null}

          {step === "deposit" ? (
            <>
              <div className="payments-auto-state">
                <strong>Deposito in corso</strong>
                <span>Deposita tutti i contanti nella cassa automatica.</span>
              </div>
              <div className="mobile-payments-settlement-note">
                Quando hai terminato il deposito premi conferma fine deposito.
              </div>
            </>
          ) : null}

          {step === "closing" || step === "completing" ? (
            <div className="payments-auto-state">
              <strong>{step === "closing" ? "Verifica deposito" : "Chiusura scarico"}</strong>
              <span>Attendi la conferma della cassa automatica.</span>
            </div>
          ) : null}

          {step === "review" || step === "completed" ? (
            <>
              {feedbackAsset && pendingResult ? (
                <div
                  className={`mobile-payments-settlement-feedback is-${pendingResult.feedbackKind}`}
                >
                  <img
                    className="mobile-payments-settlement-feedback-image"
                    src={feedbackAsset}
                    alt={`Esito scarico ${pendingResult.feedbackKind}`}
                  />
                </div>
              ) : null}
              {pendingResult && !feedbackAsset ? (
                <div className="payments-auto-state">
                  <strong>{step === "review" ? "Deposito verificato" : "Report stampato"}</strong>
                  <span>Atteso {formatCents(pendingResult.expectedDepositTotalCents)}</span>
                  <span>Depositato {formatCents(pendingResult.depositedTotalCents)}</span>
                  <span>Differenza {formatCents(pendingResult.differenceCents)}</span>
                </div>
              ) : null}
            </>
          ) : null}

          {error ? <div className="mobile-payments-settlement-note is-error">{error}</div> : null}
        </div>

        <div className="mobile-payments-settlement-actions">
          {step === "completed" ? (
            <>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-btn is-secondary"
                disabled={!completedRecord || busy || reprintBusy}
                onClick={() => void reprintCompletedReport()}
              >
                {reprintBusy ? "Ristampa..." : "Ristampa"}
              </button>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-btn is-primary"
                disabled={busy || reprintBusy}
                onClick={onClose}
              >
                Chiudi
              </button>
            </>
          ) : step === "review" ? (
            <button
              type="button"
              className="smallbtn mobile-payments-settlement-btn is-primary"
              disabled={busy || !pendingResult}
              onClick={() => void confirmAndPrint()}
            >
              {busy ? "Attendi..." : "Conferma e stampa report"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-btn is-secondary"
                disabled={busy}
                onClick={cancelFlow}
              >
                Annulla
              </button>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-btn is-primary"
                disabled={busy || loading || !context}
                onClick={step === "deposit" ? closeDeposit : startDeposit}
              >
                {busy
                  ? "Attendi..."
                  : step === "deposit"
                    ? "Conferma fine deposito"
                    : "Conferma avvicinamento"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
