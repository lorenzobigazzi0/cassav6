import type { ReservationReleasePrompt } from "../hooks/useReservationReleasePrompt";

const formatReservationReleaseTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  });

export function TableReservationReleaseDialog({
  busy,
  prompt,
  onFree,
  onSnooze,
}: {
  busy: boolean;
  prompt: ReservationReleasePrompt | null;
  onFree: () => void;
  onSnooze: () => void;
}) {
  if (!prompt) return null;

  return (
    <div className="tables-reservation-release-backdrop" role="presentation">
      <div
        className="tables-reservation-release-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Prenotazione da gestire"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tables-reservation-release-kicker">Prenotazione in attesa</div>
        <div className="tables-reservation-release-title">{prompt.tableLabel}</div>
        <p>
          Il tavolo è ancora occupato per la prenotazione di{" "}
          <strong>{prompt.customerName}</strong> delle{" "}
          <strong>{formatReservationReleaseTime(prompt.reservationAt)}</strong>.
        </p>
        <p className="tables-reservation-release-note">
          Non viene liberato automaticamente: scegli se rimandare il controllo o liberarlo ora.
        </p>
        <div className="tables-reservation-release-actions">
          <button
            type="button"
            className="smallbtn tables-reservation-release-snooze"
            onClick={onSnooze}
          >
            Rimanda 10 min
          </button>
          <button
            type="button"
            className="smallbtn tables-reservation-release-free"
            disabled={busy}
            onClick={onFree}
          >
            Libera
          </button>
        </div>
      </div>
    </div>
  );
}
