import { useEffect, useMemo, useState } from "react";
import { getAutomaticCashMovements } from "../../../api/automaticCash";
import { formatCurrency } from "../../../shared/format/currency";
import type { CashMovementRecord, CashMovementType } from "../../../types/automaticCash";
import { formatAutomaticCashError } from "../../../utils/automaticCashErrors";

type CashMovementsViewProps = {
  search: string;
};

const REFRESH_MS = 12_000;

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const lower = (value: unknown) => normalize(value).toLowerCase();

const movementTypeLabel = (type: CashMovementType) => {
  if (type === "load") return "CARICAMENTO";
  if (type === "withdrawal") return "PRELIEVO";
  return "CAMBIO MONETE";
};

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

export function CashMovementsView({ search }: CashMovementsViewProps) {
  const [movements, setMovements] = useState<CashMovementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedMovementId, setSelectedMovementId] = useState<string | null>(null);

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
    if (!query) return movements;
    return movements.filter((movement) =>
      [
        movementTypeLabel(movement.type),
        movementStatusLabel(movement.status),
        movement.ownerFullName,
        movement.justification,
        movement.movementId,
        movement.sourceId,
        movement.roomName,
        movement.roomId,
        movementAmountLabel(movement),
      ].some((value) => lower(value).includes(query))
    );
  }, [movements, search]);

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
          filteredMovements.map((movement) => (
            <article
              key={movement.movementId}
              className={`analytics-row mobile-analytics-payment-row-native cash-movement-row is-${movement.type}`}
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
                <span className={`analytics-kind-pill cash-movement-pill is-${movement.type}`}>
                  {movementTypeLabel(movement.type)}
                </span>
                <span className="analytics-time">
                  {formatDateTime(movement.completedAtMs || movement.startedAtMs)}
                </span>
              </div>
              <div className="analytics-row-main">
                <strong className={`cash-movement-amount is-${movement.type}`}>
                  {movementAmountLabel(movement)}
                </strong>
                <span>{movementStatusLabel(movement.status)}</span>
              </div>
              <div className="analytics-row-meta">
                {[movement.ownerFullName || "Operatore", movementRoomLabel(movement)]
                  .filter(Boolean)
                  .join(" - ")}
              </div>
              {movement.justification ? (
                <div className="analytics-row-note">
                  <strong>Motivo: </strong>
                  {movement.justification}
                </div>
              ) : null}
            </article>
          ))
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
                <span>{movementTypeLabel(selectedMovement.type)}</span>
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
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
