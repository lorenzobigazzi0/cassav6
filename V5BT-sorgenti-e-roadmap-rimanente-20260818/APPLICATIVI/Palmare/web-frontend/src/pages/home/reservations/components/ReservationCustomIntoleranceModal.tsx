type ReservationCustomIntoleranceModalProps = {
  draft: string;
  onChangeDraft: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function ReservationCustomIntoleranceModal({
  draft,
  onChangeDraft,
  onClose,
  onSubmit,
}: ReservationCustomIntoleranceModalProps) {
  return (
    <div className="reservations-intolerance-modal-backdrop" onClick={onClose}>
      <section
        className="reservations-intolerance-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Allergie e intolleranze personalizzate"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="reservations-intolerance-modal-head">
          <strong>Allergie e intolleranze personalizzate</strong>
          <button
            type="button"
            className="smallbtn reservations-icon-btn is-close"
            onClick={onClose}
            aria-label="Chiudi inserimento intolleranza"
          >
            X
          </button>
        </header>
        <label className="reservations-intolerance-modal-field">
          <span>Nuova voce</span>
          <input
            id="reservation-intolerances-custom"
            name="reservation_intolerances_custom"
            value={draft}
            onChange={(event) => onChangeDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Es. Nickel"
            autoFocus
          />
        </label>
        <button
          type="button"
          className="smallbtn primary"
          onClick={onSubmit}
          disabled={!draft.trim()}
        >
          Aggiungi
        </button>
      </section>
    </div>
  );
}
