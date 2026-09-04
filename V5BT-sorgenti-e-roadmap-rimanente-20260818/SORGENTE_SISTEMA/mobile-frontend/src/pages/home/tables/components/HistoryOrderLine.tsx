import type { DiningTableOrder } from "../../../../api/tables";
import { lineManualReduction } from "../payment/cartAdjustment";
import { formatCurrency } from "../utils";

type HistoryLine = DiningTableOrder["lines"][number];

const linePriceLabel = (line: HistoryLine) => {
  const qty = Math.max(1, Math.trunc(Number(line.qty) || 1));
  const unit = Number(line.unitFinalPrice ?? line.unitBasePrice ?? 0);
  if (!Number.isFinite(unit) || unit <= 0) return "";
  const total = unit * qty;
  return qty > 1
    ? `${formatCurrency(unit)} cad. - Tot. ${formatCurrency(total)}`
    : formatCurrency(total);
};

/**
 * Riga di una comanda gia' inviata, nello storico del tavolo.
 *
 * Quando una rettifica di pagamento ha ridotto il prezzo, questo si mostra in
 * ambra e sotto compare la riduzione. Qui e' sola lettura: per annullare si usa
 * il flusso di correzione comanda.
 */
export function HistoryOrderLine({ line }: { line: HistoryLine }) {
  const priceLabel = linePriceLabel(line);
  const reduction = lineManualReduction(line);
  return (
    <div
      className={`table-history-line ${priceLabel ? "mobile-service-recovery-priced-line" : ""}`}
      data-line-id={line.lineId}
    >
      <span className={priceLabel ? "mobile-service-recovery-line-left" : undefined}>
        <span>
          {line.qty}x {line.name}
          {line.variantName ? ` (${line.variantName})` : ""}
        </span>
        {line.note ? <small>Nota: {line.note}</small> : null}
      </span>
      {priceLabel ? (
        <span
          className={`mobile-service-recovery-line-price table-history-line-price ${
            reduction > 0 ? "is-adjusted" : ""
          }`}
        >
          {priceLabel}
        </span>
      ) : null}
      {reduction > 0 ? (
        <span className="table-history-line-reduction">
          Riduzione importo Articolo <strong>-{formatCurrency(reduction)}</strong>
        </span>
      ) : null}
    </div>
  );
}
