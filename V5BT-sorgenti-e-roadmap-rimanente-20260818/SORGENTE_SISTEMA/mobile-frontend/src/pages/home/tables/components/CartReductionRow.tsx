import { formatCurrency } from "../../../../shared/format/currency";
import { formatReduction } from "../payment/cartAdjustment";

/**
 * Riga che dichiara una riduzione dentro il carrello.
 *
 * Riusa `table-order-item` come le righe articolo ma senza toggle ne'
 * quantita', sulla scia di `msr-replacement-row`: e' una voce di documento,
 * non un articolo ordinabile. L'importo e' sempre in negativo.
 */
export function CartReductionRow({
  label,
  amount,
  note,
  perLine = false,
  onRemove,
}: {
  label: string;
  amount: number;
  note?: string;
  perLine?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className={`table-order-item is-reduction ${perLine ? "is-reduction-line" : ""}`}>
      <div className="table-order-item-info">
        <strong>{label}</strong>
        {note ? <span>{note}</span> : null}
      </div>
      <div className="table-order-item-total is-adjusted">
        {formatReduction(amount, formatCurrency)}
      </div>
      {onRemove ? (
        <button
          type="button"
          className="table-order-reduction-remove"
          onClick={onRemove}
          aria-label={perLine ? "Elimina riduzione articolo" : "Annulla rettifica"}
        >
          &times;
        </button>
      ) : null}
    </div>
  );
}
