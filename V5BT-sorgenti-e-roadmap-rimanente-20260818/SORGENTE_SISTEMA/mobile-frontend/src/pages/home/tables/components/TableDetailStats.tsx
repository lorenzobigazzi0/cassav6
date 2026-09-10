import { formatCurrency } from "../utils";

/**
 * Il riepilogo sotto l'anagrafica del tavolo e l'avviso di configurazione
 * mancante dei pagamenti.
 *
 * Vivono qui e non dentro `TableDetailPanel` perche' quel file e' a un soffio
 * dal suo tetto di righe: le icone in linea lo avrebbero sfondato.
 *
 * Le icone sono SVG con `currentColor`, cosi' prendono il colore dalla
 * pastiglia che le contiene e seguono il tema senza duplicare le risorse.
 */

const iconaComune = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const IconaOrdiniPresi = () => (
  <svg {...iconaComune}>
    <path d="M9 4.5h6M9 4.5a1.5 1.5 0 0 0-1.5 1.5v.5h9V6A1.5 1.5 0 0 0 15 4.5" />
    <path d="M7.5 6H6.8A1.8 1.8 0 0 0 5 7.8v10.4A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8V7.8A1.8 1.8 0 0 0 17.2 6h-.7" />
    <path d="M8.6 11h6.8M8.6 14.5h4.6" />
  </svg>
);

const IconaOrdiniInCorso = () => (
  <svg {...iconaComune}>
    <circle cx="12" cy="12" r="7.6" />
    <path d="M12 7.8V12l2.8 1.9" />
  </svg>
);

const IconaDaRiscuotere = () => (
  <svg {...iconaComune}>
    <path d="M4.6 8.4A1.8 1.8 0 0 1 6.4 6.6h9.9a1.8 1.8 0 0 1 1.8 1.8" />
    <path d="M4.6 8.4v7.4a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-1.6" />
    <path d="M19.4 10.6h-3.1a1.7 1.7 0 0 0 0 3.4h3.1a.9.9 0 0 0 .9-.9v-1.6a.9.9 0 0 0-.9-.9Z" />
  </svg>
);

const IconaAvviso = () => (
  <svg {...iconaComune}>
    <path d="M12 4.9 3.6 19.1h16.8L12 4.9Z" />
    <path d="M12 10.2v3.6M12 16.6h.01" />
  </svg>
);

type TableDetailStatsProps = {
  ordersTaken: number;
  ordersInProgress: number;
  amountDue: number;
};

export function TableDetailStats({
  ordersTaken,
  ordersInProgress,
  amountDue,
}: TableDetailStatsProps) {
  return (
    <div className="table-detail-stats">
      <div className="table-detail-stat">
        <span className="table-detail-stat-label">PRESI</span>
        <span className="table-detail-stat-text">
          <span className="table-detail-stat-icon is-taken">
            <IconaOrdiniPresi />
          </span>
          <strong className="table-detail-stat-value">{ordersTaken}</strong>
        </span>
      </div>
      <div className="table-detail-stat">
        <span className="table-detail-stat-label">IN CORSO</span>
        <span className="table-detail-stat-text">
          <span className="table-detail-stat-icon is-progress">
            <IconaOrdiniInCorso />
          </span>
          <strong className="table-detail-stat-value">{ordersInProgress}</strong>
        </span>
      </div>
      <div className="table-detail-stat">
        <span className="table-detail-stat-label">DA RISCUOTERE</span>
        <span className="table-detail-stat-text">
          <span className="table-detail-stat-icon is-due">
            <IconaDaRiscuotere />
          </span>
          <strong className="table-detail-stat-value">{formatCurrency(amountDue)}</strong>
        </span>
      </div>
    </div>
  );
}

/**
 * L'avviso e' un pulsante, non un cartello: la freccia porta alla pagina dei
 * pagamenti, che e' dove si inserisce il POS o si conferma il fondo cassa.
 * Un chevron che non porta da nessuna parte prometterebbe un tocco che non
 * succede.
 */
export function TablePaymentSetupHint({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="table-payment-setup-hint"
      onClick={onOpen}
      aria-label="Pagamenti disabilitati: apri le impostazioni dei pagamenti"
    >
      <span className="table-payment-setup-icon">
        <IconaAvviso />
      </span>
      <span className="table-payment-setup-text">
        <strong>Pagamenti disabilitati: inserisci un POS</strong>
        <span>o conferma il fondo cassa.</span>
      </span>
      <svg
        className="table-payment-setup-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9.5 5.5 16 12l-6.5 6.5" />
      </svg>
    </button>
  );
}
