import { useEffect, useMemo, useState } from "react";
import { getAutomaticCashMovements, printAutomaticCashMovementReport } from "../../../api/automaticCash";
import { formatCurrency } from "../../../shared/format/currency";
import type { CashMovementRecord, CashMovementType } from "../../../types/automaticCash";
import { formatAutomaticCashError } from "../../../utils/automaticCashErrors";

type CashMovementsViewProps = {
  search: string;
  selectedKinds?: CashMovementDisplayKind[];
};

const REFRESH_MS = 12_000;

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const lower = (value: unknown) => normalize(value).toLowerCase();

export type CashMovementDisplayKind = "refill" | "exchange" | "withdrawal" | "extraction";

export const cashMovementDisplayKind = (
  movement: Pick<CashMovementRecord, "type" | "justification">
): CashMovementDisplayKind => {
  if (movement.type === "load") return "refill";
  if (movement.type === "exchange") return "exchange";
  const purpose = lower(movement.justification);
  return /estraz|overflow|cassetto/.test(purpose) ? "extraction" : "withdrawal";
};

const movementKindLabel = (kind: CashMovementDisplayKind) => {
  if (kind === "refill") return "RIFORNIMENTO";
  if (kind === "exchange") return "CAMBIO";
  if (kind === "extraction") return "ESTRAZIONE";
  return "PRELIEVO";
};

const movementTypeLabel = (movement: CashMovementRecord) =>
  movementKindLabel(cashMovementDisplayKind(movement));

const movementKindDescription = (kind: CashMovementDisplayKind) => {
  if (kind === "refill") return "Caricamento contanti nella cassa";
  if (kind === "exchange") return "Cambio monete o contanti in altri tagli";
  if (kind === "extraction") return "Estrazione cassetto overflow banconote";
  return "Prelievo di contanti o monete";
};

const MovementKindIcon = ({ kind }: { kind: CashMovementDisplayKind }) => (
  <svg className="analytics-kind-pill-icon" viewBox="0 0 24 24" aria-hidden="true">
    {kind === "refill" ? (
      <><path d="M12 4v12M7 9l5-5 5 5" /><path d="M5 19h14" /></>
    ) : kind === "exchange" ? (
      <><path d="M7 7h11l-3-3M17 17H6l3 3" /><path d="M18 7l-3 3M6 17l3-3" /></>
    ) : kind === "extraction" ? (
      <><rect x="4" y="5" width="16" height="12" rx="2" /><path d="M8 11h8M12 17v4M9 21h6" /></>
    ) : (
      <><path d="M12 20V8M7 15l5 5 5-5" /><path d="M5 5h14" /></>
    )}
  </svg>
);

const movementStatusLabel = (status: string) => {
  if (status === "COMPLETED") return "Completato";
  if (status === "CANCELLED") return "Annullato";
  if (status === "FAILED") return "Non riuscito";
  if (status === "WAITING_CASH_REMOVAL") return "Da ritirare";
  if (status === "ACTIVE") return "In corso";
  return "In avvio";
};

const formatDateTime = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
};

const movementAmountCents = (movement: CashMovementRecord) =>
  movement.type === "withdrawal"
    ? movement.requestedAmountCents || movement.amountCents
    : movement.amountCents;

const movementAmountLabel = (movement: CashMovementRecord) => {
  const cents = movementAmountCents(movement);
  if (cents <= 0 && movement.status !== "COMPLETED") return "IN CORSO";
  const amount = formatCurrency(cents / 100);
  if (movement.type === "withdrawal") return `-${amount}`;
  return movement.type === "load" ? `+${amount}` : amount;
};

const movementRoomLabel = (movement: CashMovementRecord) =>
  [movement.roomName, movement.roomId].find((value) => normalize(value)) ||
  "Postazione non indicata";

const DetailLine = ({ label, value }: { label: string; value: unknown }) => {
  const text = normalize(value);
  if (!text) return null;
  return (
    <div className="mobile-analytics-detail-line">
      <span>{label}</span>
      <strong>{text}</strong>
    </div>
  );
};

export function CashMovementsView({ search, selectedKinds = [] }: CashMovementsViewProps) {
  const [movements, setMovements] = useState<CashMovementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedMovementId, setSelectedMovementId] = useState<string | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState("");

  useEffect(() => {
    let alive = true;

    const refresh = async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        const response = await getAutomaticCashMovements();
        if (!alive) return;
        setMovements(response.movements);
        setError("");
      } catch (caught) {
        if (!alive) return;
        setError(formatAutomaticCashError(caught, "Movimenti cassa non disponibili."));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void refresh(true);
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("mobile:automatic-cash-movements-changed", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("mobile:automatic-cash-movements-changed", onFocus);
    };
  }, []);

  const filteredMovements = useMemo(() => {
    const query = lower(search);
    return movements.filter((movement) =>
      (selectedKinds.length === 0 || selectedKinds.includes(cashMovementDisplayKind(movement))) &&
      (!query ||
        [
          movementTypeLabel(movement),
          movementStatusLabel(movement.status),
          movement.ownerFullName,
          movement.justification,
          movement.movementId,
          movement.sourceId,
          movement.roomName,
          movement.roomId,
          movementAmountLabel(movement),
        ].some((value) => lower(value).includes(query)))
    );
  }, [movements, search, selectedKinds]);

  const selectedMovement =
    movements.find((movement) => movement.movementId === selectedMovementId) ?? null;

  return (
    <>
      <div className="analytics-list cash-movements-list">
        {loading && movements.length === 0 ? (
          <div className="analytics-empty">Caricamento movimenti cassa...</div>
        ) : error && movements.length === 0 ? (
          <div className="analytics-empty is-error">{error}</div>
        ) : filteredMovements.length === 0 ? (
          <div className="analytics-empty">Nessun movimento cassa trovato.</div>
        ) : (
          filteredMovements.map((movement) => {
            const displayKind = cashMovementDisplayKind(movement);
            return <article
              key={movement.movementId}
              className={`analytics-row mobile-analytics-payment-row-native cash-movement-row is-${displayKind}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedMovementId(movement.movementId)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setSelectedMovementId(movement.movementId);
              }}
            >
              <div className="analytics-row-top">
                <span className={`analytics-kind-pill cash-movement-pill is-${displayKind}`}>
                  <MovementKindIcon kind={displayKind} />
                  {movementKindLabel(displayKind)}
                </span>
                <span className="analytics-time">
                  {formatDateTime(movement.completedAtMs || movement.startedAtMs)}
                </span>
              </div>
              <div className="analytics-row-main">
                <strong className={`cash-movement-amount is-${displayKind}`}>
                  {movementAmountLabel(movement)}
                </strong>
                <span>{movementKindDescription(displayKind)}</span>
              </div>
            </article>;
          })
        )}
      </div>

      {selectedMovement ? (
        <div
          className="mobile-analytics-detail-backdrop"
          onPointerDown={() => setSelectedMovementId(null)}
        >
          <section
            className="mobile-analytics-detail-modal cash-movement-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Dettaglio movimento cassa"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="mobile-analytics-detail-head">
              <div>
                <span>{movementTypeLabel(selectedMovement)}</span>
                <strong>DETTAGLIO MOVIMENTO</strong>
              </div>
              <div className="mobile-analytics-detail-actions">
                <button
                  type="button"
                  className="smallbtn mobile-analytics-detail-close"
                  aria-label="Chiudi"
                  onClick={() => setSelectedMovementId(null)}
                >
                  X
                </button>
              </div>
            </header>
            <div className="mobile-analytics-detail-body">
              <DetailLine
                label="Data"
                value={formatDateTime(
                  selectedMovement.completedAtMs || selectedMovement.startedAtMs
                )}
              />
              <DetailLine label="Stato" value={movementStatusLabel(selectedMovement.status)} />
              <DetailLine label="Importo" value={movementAmountLabel(selectedMovement)} />
              <DetailLine label="Operatore" value={selectedMovement.ownerFullName} />
              <DetailLine label="Postazione / Sala" value={movementRoomLabel(selectedMovement)} />
              <DetailLine label="Giustificazione" value={selectedMovement.justification} />
              <DetailLine label="ID movimento" value={selectedMovement.movementId} />
              <DetailLine label="Errore" value={selectedMovement.error} />
              {printError ? <div className="mobile-analytics-detail-error">{printError}</div> : null}
            </div>
            <footer className="mobile-analytics-detail-foot">
              <button
                type="button"
                className="smallbtn mobile-analytics-detail-print"
                disabled={printBusy}
                onClick={async () => {
                  setPrintBusy(true);
                  setPrintError("");
                  try {
                    await printAutomaticCashMovementReport(selectedMovement.movementId, {
                      clientRequestId: `analytics-cash-${selectedMovement.movementId}-${Date.now()}`,
                      reprint: true,
                    });
                  } catch (caught) {
                    setPrintError(formatAutomaticCashError(caught, "Stampa movimento non riuscita."));
                  } finally {
                    setPrintBusy(false);
                  }
                }}
              >
                <svg className="analytics-kind-pill-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V4h10v4M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v6H7z" /></svg>
                <span>{printBusy ? "STAMPA..." : "STAMPA"}</span>
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
