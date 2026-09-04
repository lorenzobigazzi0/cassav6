import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelAutomaticCashMovement,
  completeAutomaticCashMovement,
  getAutomaticCashMovementState,
  getCashMovementWithdrawalAvailability,
  prepareAutomaticCashMovement,
  printAutomaticCashMovementReport,
  startAutomaticCashMovement,
} from "../../api/automaticCash";
import { formatCurrency } from "../../shared/format/currency";
import type {
  CashFloatDenominationMap,
  CashMovementRecord,
  CashMovementWithdrawalDenomination,
  StartCashMovementRequest,
} from "../../types/automaticCash";
import { formatAutomaticCashError } from "../../utils/automaticCashErrors";

type OperableCashMovementType = StartCashMovementRequest["type"];

type CashMovementModalProps = {
  open: boolean;
  type: OperableCashMovementType;
  activeMovement?: CashMovementRecord | null;
  deviceUuid?: string | null;
  activityId?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  onClose: () => void;
};

const movementTitle = (type: OperableCashMovementType) =>
  type === "load" ? "Caricamento" : "Prelievo";

const buildClientRequestId = (prefix: string) => {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
};

const piecesTotal = (pieces: CashFloatDenominationMap) =>
  Object.entries(pieces).reduce(
    (sum, [rawCents, rawQuantity]) => sum + Number(rawCents) * Number(rawQuantity),
    0
  );

const piecesCount = (pieces: CashFloatDenominationMap) =>
  Object.values(pieces).reduce((sum, quantity) => sum + Number(quantity), 0);

const sortedPieces = (pieces: CashFloatDenominationMap) =>
  Object.entries(pieces)
    .map(([rawCents, rawQuantity]) => ({
      cents: Number(rawCents),
      quantity: Number(rawQuantity),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.cents) &&
        entry.cents > 0 &&
        Number.isInteger(entry.quantity) &&
        entry.quantity > 0
    )
    .sort((left, right) => right.cents - left.cents);

const isTerminal = (movement: CashMovementRecord | null) =>
  Boolean(movement && ["COMPLETED", "CANCELLED", "FAILED"].includes(movement.status));

function MovementProgress({
  type,
  activeIndex,
}: {
  type: OperableCashMovementType;
  activeIndex: number;
}) {
  const labels =
    type === "load"
      ? ["Vicino", "Inserimento", "Riepilogo", "Report"]
      : ["Vicino", "Tagli", "Ritiro", "Report"];
  return (
    <ol className="cash-movement-progress" aria-label="Avanzamento procedura">
      {labels.map((label, index) => (
        <li
          key={label}
          className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""}
        >
          <span>{index + 1}</span>
          <b>{label}</b>
        </li>
      ))}
    </ol>
  );
}

function DenominationSummary({
  pieces,
  emptyLabel = "Nessun taglio rilevato.",
}: {
  pieces: CashFloatDenominationMap;
  emptyLabel?: string;
}) {
  const rows = sortedPieces(pieces);
  if (rows.length === 0) {
    return <div className="cash-movement-denomination-empty">{emptyLabel}</div>;
  }
  return (
    <div className="cash-movement-denomination-summary">
      {rows.map((entry) => (
        <div key={entry.cents} className="cash-movement-denomination-summary-row">
          <span>{formatCurrency(entry.cents / 100)}</span>
          <b>x {entry.quantity}</b>
          <strong>{formatCurrency((entry.cents * entry.quantity) / 100)}</strong>
        </div>
      ))}
    </div>
  );
}

export function CashMovementModal({
  open,
  type,
  activeMovement = null,
  deviceUuid,
  activityId,
  roomId,
  roomName,
  onClose,
}: CashMovementModalProps) {
  const [movement, setMovement] = useState<CashMovementRecord | null>(activeMovement);
  const [justification, setJustification] = useState("");
  const [clientRequestId, setClientRequestId] = useState(() =>
    buildClientRequestId(`cash-${type}`)
  );
  const [approachConfirmed, setApproachConfirmed] = useState(false);
  const [withdrawalReview, setWithdrawalReview] = useState(false);
  const [availability, setAvailability] = useState<CashMovementWithdrawalDenomination[]>([]);
  const [selectedPieces, setSelectedPieces] = useState<CashFloatDenominationMap>({});
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reportMessage, setReportMessage] = useState("");
  const autoPrintAttemptedRef = useRef("");

  useEffect(() => {
    if (!open) return;
    setMovement(activeMovement);
    setJustification(activeMovement?.justification ?? "");
    setClientRequestId(activeMovement?.clientRequestId || buildClientRequestId(`cash-${type}`));
    setApproachConfirmed(Boolean(activeMovement));
    setWithdrawalReview(false);
    setAvailability([]);
    setSelectedPieces(activeMovement?.pieces ?? {});
    setAvailabilityLoading(false);
    setBusy(false);
    setError("");
    setReportMessage("");
    autoPrintAttemptedRef.current = "";
  }, [activeMovement, open, type]);

  const effectiveType: OperableCashMovementType =
    movement?.type === "withdrawal" ? "withdrawal" : movement?.type === "load" ? "load" : type;
  const title = movementTitle(effectiveType);
  const terminal = isTerminal(movement);
  const effectivePieces = movement?.pieces ?? selectedPieces;
  const totalCents = movement
    ? Math.max(
        0,
        movement.amountCents,
        movement.requestedAmountCents,
        movement.piecesTotalCents ?? 0
      )
    : piecesTotal(selectedPieces);
  const totalSelectedPieces = piecesCount(selectedPieces);

  const loadAvailability = useCallback(async () => {
    setAvailabilityLoading(true);
    setError("");
    try {
      const response = await getCashMovementWithdrawalAvailability();
      setAvailability(response.denominations);
      setSelectedPieces((current) => {
        const next: CashFloatDenominationMap = {};
        response.denominations.forEach((entry) => {
          const selected = Math.min(
            Math.max(0, Number(current[String(entry.cents)]) || 0),
            entry.availablePieces
          );
          if (selected > 0) next[String(entry.cents)] = selected;
        });
        return next;
      });
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Lettura tagli disponibili non riuscita."));
    } finally {
      setAvailabilityLoading(false);
    }
  }, []);

  const printReport = useCallback(async (target: CashMovementRecord, reprint: boolean) => {
    setBusy(true);
    setError("");
    setReportMessage("");
    try {
      const response = await printAutomaticCashMovementReport(target.movementId, {
        clientRequestId: reprint
          ? buildClientRequestId(`cash-report-${target.movementId}-reprint`)
          : `cash-report-${target.movementId}-initial`,
        reprint,
      });
      setMovement(response.movement);
      if (reprint) setReportMessage("Ristampa inviata correttamente.");
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Stampa report non riuscita."));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (
      !open ||
      busy ||
      movement?.status !== "WAITING_REPORT" ||
      autoPrintAttemptedRef.current === movement.movementId
    ) {
      return;
    }
    autoPrintAttemptedRef.current = movement.movementId;
    void printReport(movement, false);
  }, [busy, movement, open, printReport]);

  useEffect(() => {
    if (!open || movement?.type !== "load" || movement.status !== "ACTIVE") return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling || cancelled) return;
      polling = true;
      try {
        const response = await getAutomaticCashMovementState(movement.movementId, {
          timeoutMs: 10_000,
        });
        if (!cancelled && response.movement) {
          setMovement(response.movement);
          if (!response.gatewayReachable && response.gatewayError) {
            setError(`Aggiornamento temporaneamente sospeso: ${response.gatewayError}`);
          } else {
            setError("");
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            formatAutomaticCashError(caught, "Aggiornamento tagli temporaneamente non disponibile.")
          );
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [movement?.movementId, movement?.status, movement?.type, open]);

  if (!open) return null;

  const confirmApproach = async () => {
    setApproachConfirmed(true);
    setError("");
    if (effectiveType === "withdrawal") await loadAvailability();
  };

  const updatePiece = (denomination: CashMovementWithdrawalDenomination, delta: number) => {
    if (busy) return;
    setSelectedPieces((current) => {
      const key = String(denomination.cents);
      const quantity = Math.min(
        denomination.availablePieces,
        Math.max(0, (Number(current[key]) || 0) + delta)
      );
      const next = { ...current };
      if (quantity > 0) next[key] = quantity;
      else delete next[key];
      return next;
    });
    setError("");
  };

  const start = async () => {
    if (busy) return;
    if (justification.trim().length < 3) {
      setError("Inserisci la giustificazione del movimento.");
      return;
    }
    if (effectiveType === "withdrawal" && totalSelectedPieces <= 0) {
      setError("Seleziona almeno un taglio.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const selectedTotalCents = piecesTotal(selectedPieces);
      const response = await startAutomaticCashMovement({
        clientRequestId,
        type: effectiveType,
        ...(effectiveType === "withdrawal"
          ? { amountCents: selectedTotalCents, pieces: selectedPieces }
          : {}),
        justification: justification.trim(),
        deviceUuid: deviceUuid || undefined,
        activityId: activityId || undefined,
        roomId: roomId || undefined,
        roomName: roomName || undefined,
      });
      setMovement(response.movement);
      setWithdrawalReview(false);
    } catch (caught) {
      setError(formatAutomaticCashError(caught, `Avvio ${title.toLowerCase()} non riuscito.`));
    } finally {
      setBusy(false);
    }
  };

  const prepareLoad = async () => {
    if (!movement || busy || movement.status !== "ACTIVE") return;
    setBusy(true);
    setError("");
    try {
      const response = await prepareAutomaticCashMovement(movement.movementId);
      setMovement(response.movement);
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Chiusura inserimento non riuscita."));
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!movement || busy || terminal) return;
    setBusy(true);
    setError("");
    try {
      const response = await completeAutomaticCashMovement(movement.movementId, {
        awaitingReport: true,
      });
      setMovement(response.movement);
    } catch (caught) {
      setError(
        formatAutomaticCashError(caught, `Completamento ${title.toLowerCase()} non riuscito.`)
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!movement || movement.type !== "load" || busy || terminal) return;
    setBusy(true);
    setError("");
    try {
      const response = await cancelAutomaticCashMovement(movement.movementId);
      setMovement(response.movement);
    } catch (caught) {
      setError(formatAutomaticCashError(caught, "Annullamento caricamento non riuscito."));
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (!busy) onClose();
  };

  const progressIndex = (() => {
    if (movement?.status === "COMPLETED" || movement?.status === "WAITING_REPORT") return 3;
    if (effectiveType === "load" && movement?.status === "REVIEW_REQUIRED") return 2;
    if (effectiveType === "withdrawal" && movement?.status === "WAITING_CASH_REMOVAL") return 2;
    if (approachConfirmed || movement) return 1;
    return 0;
  })();

  const renderBody = () => {
    if (!movement && !approachConfirmed) {
      return (
        <div className="cash-movement-approach">
          <div className="cash-movement-machine-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="5" y="3" width="14" height="18" rx="2" />
              <path d="M8 7h8M8 11h8M9 16h6" />
            </svg>
          </div>
          <strong>Avvicinati alla cassa automatica</strong>
          <span>
            Conferma solo quando sei davanti alla macchina e puoi seguire l'operazione fino al
            termine.
          </span>
        </div>
      );
    }

    if (!movement && effectiveType === "load") {
      return (
        <>
          <div className="cash-movement-instruction">
            <strong>Prepara il caricamento</strong>
            <span>Dopo l'avvio inserisci tutti i contanti senza allontanarti dalla cassa.</span>
          </div>
          <label className="payments-modal-field cash-movement-field">
            <span>Giustificazione *</span>
            <textarea
              value={justification}
              maxLength={500}
              placeholder="Es. reintegro monete inizio turno"
              onChange={(event) => {
                setJustification(event.target.value);
                setError("");
              }}
            />
          </label>
        </>
      );
    }

    if (!movement && effectiveType === "withdrawal" && !withdrawalReview) {
      return (
        <>
          <div className="cash-movement-instruction">
            <strong>Scegli i tagli</strong>
            <span>Le quantita disponibili tengono gia conto della riserva minima.</span>
          </div>
          {availabilityLoading ? (
            <div className="cash-movement-loading">Lettura inventario...</div>
          ) : (
            <div className="cash-movement-denomination-picker">
              {availability.map((entry) => {
                const quantity = Number(selectedPieces[String(entry.cents)]) || 0;
                return (
                  <div className="cash-movement-denomination-row" key={entry.cents}>
                    <div>
                      <strong>{formatCurrency(entry.cents / 100)}</strong>
                      <span>Disponibili {entry.availablePieces}</span>
                    </div>
                    <div className="cash-movement-stepper">
                      <button
                        type="button"
                        aria-label={`Rimuovi un taglio da ${formatCurrency(entry.cents / 100)}`}
                        disabled={busy || quantity <= 0}
                        onClick={() => updatePiece(entry, -1)}
                      >
                        -
                      </button>
                      <b>{quantity}</b>
                      <button
                        type="button"
                        aria-label={`Aggiungi un taglio da ${formatCurrency(entry.cents / 100)}`}
                        disabled={busy || quantity >= entry.availablePieces}
                        onClick={() => updatePiece(entry, 1)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
              {!availabilityLoading && availability.length === 0 ? (
                <div className="cash-movement-denomination-empty">
                  Nessun taglio erogabile disponibile.
                </div>
              ) : null}
            </div>
          )}
          <div className="cash-movement-total">
            <span>{totalSelectedPieces} pezzi selezionati</span>
            <strong>{formatCurrency(piecesTotal(selectedPieces) / 100)}</strong>
          </div>
          <label className="payments-modal-field cash-movement-field">
            <span>Giustificazione *</span>
            <textarea
              value={justification}
              maxLength={500}
              placeholder="Es. acquisto urgente per il locale"
              onChange={(event) => {
                setJustification(event.target.value);
                setError("");
              }}
            />
          </label>
        </>
      );
    }

    if (!movement && effectiveType === "withdrawal" && withdrawalReview) {
      return (
        <>
          <div className="cash-movement-instruction is-warning">
            <strong>Conferma il prelievo</strong>
            <span>La conferma avvia l'erogazione reale dei tagli indicati.</span>
          </div>
          <DenominationSummary pieces={selectedPieces} />
          <div className="cash-movement-total is-review">
            <span>Totale da erogare</span>
            <strong>{formatCurrency(piecesTotal(selectedPieces) / 100)}</strong>
          </div>
          <div className="cash-movement-reason">
            <span>Giustificazione</span>
            <strong>{justification}</strong>
          </div>
        </>
      );
    }

    if (movement?.status === "ACTIVE" && movement.type === "load") {
      return (
        <>
          <div className="cash-movement-live">
            <span>Totale inserito</span>
            <strong>{formatCurrency(totalCents / 100)}</strong>
            <b>Aggiornamento automatico</b>
          </div>
          <DenominationSummary
            pieces={effectivePieces}
            emptyLabel="In attesa del primo contante..."
          />
          <div className="cash-movement-instruction">
            <strong>Inserimento in corso</strong>
            <span>Quando hai inserito tutto, concludi l'inserimento per vedere il riepilogo.</span>
          </div>
        </>
      );
    }

    if (movement?.status === "REVIEW_REQUIRED") {
      return (
        <>
          <div className="cash-movement-instruction is-success">
            <strong>Contanti acquisiti</strong>
            <span>Controlla tagli e quantita prima della conferma definitiva.</span>
          </div>
          <DenominationSummary pieces={effectivePieces} />
          <div className="cash-movement-total is-review">
            <span>Totale caricato</span>
            <strong>{formatCurrency(totalCents / 100)}</strong>
          </div>
          <div className="cash-movement-reason">
            <span>Giustificazione</span>
            <strong>{movement.justification}</strong>
          </div>
        </>
      );
    }

    if (movement?.status === "WAITING_CASH_REMOVAL") {
      return (
        <>
          <div className="cash-movement-instruction is-warning">
            <strong>Ritira tutti i contanti</strong>
            <span>Controlla il vano di erogazione, poi conferma di aver ritirato tutto.</span>
          </div>
          <DenominationSummary pieces={effectivePieces} />
          <div className="cash-movement-total is-review">
            <span>Totale erogato</span>
            <strong>{formatCurrency(totalCents / 100)}</strong>
          </div>
        </>
      );
    }

    if (movement?.status === "WAITING_REPORT") {
      return (
        <div className="cash-movement-printing">
          <span className="cash-movement-spinner" aria-hidden="true" />
          <strong>{error ? "Report in attesa" : "Stampa report in corso"}</strong>
          <span>
            {error
              ? "Il movimento e al sicuro. Riprova la stampa senza ripetere l'operazione."
              : "La procedura si chiudera appena il report sara inviato alla stampante."}
          </span>
        </div>
      );
    }

    if (movement?.status === "COMPLETED") {
      return (
        <>
          <div className="cash-movement-completed-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </div>
          <div className="cash-movement-instruction is-success is-centered">
            <strong>{title} completato</strong>
            <span>Il report e stato inviato alla stampante.</span>
          </div>
          <div className="cash-movement-total is-review">
            <span>Totale</span>
            <strong>{formatCurrency(totalCents / 100)}</strong>
          </div>
          {reportMessage ? <div className="payments-alert is-success">{reportMessage}</div> : null}
        </>
      );
    }

    if (movement?.status === "CANCELLED" || movement?.status === "FAILED") {
      return (
        <div
          className={`cash-movement-instruction ${movement.status === "FAILED" ? "is-error" : ""}`}
        >
          <strong>
            {movement.status === "FAILED" ? `${title} non riuscito` : "Caricamento annullato"}
          </strong>
          <span>
            {movement.error || "La procedura e stata chiusa senza completare il movimento."}
          </span>
        </div>
      );
    }

    return (
      <div className="cash-movement-loading">
        {busy && effectiveType === "withdrawal"
          ? "Erogazione in corso..."
          : "Preparazione operazione..."}
      </div>
    );
  };

  const renderActions = () => {
    if (!movement && !approachConfirmed) {
      return (
        <button
          type="button"
          className={`smallbtn cash-movement-primary is-${effectiveType}`}
          disabled={busy}
          onClick={() => void confirmApproach()}
        >
          {availabilityLoading ? "VERIFICA..." : "SONO DAVANTI ALLA CASSA"}
        </button>
      );
    }
    if (!movement && effectiveType === "load") {
      return (
        <button
          type="button"
          className="smallbtn cash-movement-primary is-load"
          disabled={busy || justification.trim().length < 3}
          onClick={() => void start()}
        >
          {busy ? "AVVIO..." : "AVVIA INSERIMENTO"}
        </button>
      );
    }
    if (!movement && effectiveType === "withdrawal" && !withdrawalReview) {
      return (
        <>
          <button
            type="button"
            className="smallbtn cash-movement-secondary"
            disabled={busy}
            onClick={() => {
              setApproachConfirmed(false);
              setError("");
            }}
          >
            INDIETRO
          </button>
          <button
            type="button"
            className="smallbtn cash-movement-primary is-withdrawal"
            disabled={
              busy ||
              availabilityLoading ||
              totalSelectedPieces <= 0 ||
              justification.trim().length < 3
            }
            onClick={() => setWithdrawalReview(true)}
          >
            RIVEDI PRELIEVO
          </button>
        </>
      );
    }
    if (!movement && effectiveType === "withdrawal" && withdrawalReview) {
      return (
        <>
          <button
            type="button"
            className="smallbtn cash-movement-secondary"
            disabled={busy}
            onClick={() => setWithdrawalReview(false)}
          >
            MODIFICA
          </button>
          <button
            type="button"
            className="smallbtn cash-movement-primary is-withdrawal"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? "EROGAZIONE..." : "CONFERMA PRELIEVO"}
          </button>
        </>
      );
    }
    if (movement?.status === "ACTIVE" && movement.type === "load") {
      return (
        <>
          <button
            type="button"
            className="smallbtn cash-movement-secondary"
            disabled={busy}
            onClick={() => void cancel()}
          >
            ANNULLA
          </button>
          <button
            type="button"
            className="smallbtn cash-movement-primary is-load"
            disabled={busy}
            onClick={() => void prepareLoad()}
          >
            {busy ? "CHIUSURA..." : "TERMINA INSERIMENTO"}
          </button>
        </>
      );
    }
    if (movement?.status === "REVIEW_REQUIRED") {
      return (
        <button
          type="button"
          className="smallbtn cash-movement-primary is-load"
          disabled={busy}
          onClick={() => void complete()}
        >
          {busy ? "CONFERMA..." : "CONFERMA CARICAMENTO"}
        </button>
      );
    }
    if (movement?.status === "WAITING_CASH_REMOVAL") {
      return (
        <button
          type="button"
          className="smallbtn cash-movement-primary is-withdrawal"
          disabled={busy}
          onClick={() => void complete()}
        >
          {busy ? "CONFERMA..." : "HO RITIRATO TUTTO"}
        </button>
      );
    }
    if (movement?.status === "WAITING_REPORT") {
      return (
        <button
          type="button"
          className="smallbtn cash-movement-primary is-close"
          disabled={busy}
          onClick={() => {
            autoPrintAttemptedRef.current = movement.movementId;
            void printReport(movement, false);
          }}
        >
          {busy ? "STAMPA IN CORSO..." : "RIPROVA STAMPA"}
        </button>
      );
    }
    if (movement?.status === "COMPLETED") {
      return (
        <>
          <button
            type="button"
            className="smallbtn cash-movement-secondary"
            disabled={busy}
            onClick={() => void printReport(movement, true)}
          >
            {busy ? "RISTAMPA..." : "RISTAMPA"}
          </button>
          <button
            type="button"
            className="smallbtn cash-movement-primary is-close"
            disabled={busy}
            onClick={requestClose}
          >
            {movement.type === "load" ? "CHIUDI CARICAMENTO" : "TERMINA RITIRO"}
          </button>
        </>
      );
    }
    return (
      <button
        type="button"
        className="smallbtn cash-movement-primary is-close"
        onClick={requestClose}
      >
        CHIUDI
      </button>
    );
  };

  return (
    <div className="payments-confirm-backdrop cash-movement-backdrop" onClick={requestClose}>
      <section
        className={`payments-confirm-card cash-movement-card is-${effectiveType}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="payments-confirm-head cash-movement-head">
          <div>
            <span>Procedura guidata</span>
            <strong>{title}</strong>
          </div>
          <button
            type="button"
            className="smallbtn payments-confirm-close"
            aria-label={`Chiudi ${title.toLowerCase()}`}
            disabled={busy}
            onClick={requestClose}
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </header>

        <MovementProgress type={effectiveType} activeIndex={progressIndex} />

        <div className="payments-confirm-body cash-movement-body">
          {renderBody()}
          {error ? <div className="payments-alert is-error">{error}</div> : null}
        </div>

        <footer className="cash-movement-actions">{renderActions()}</footer>
      </section>
    </div>
  );
}
