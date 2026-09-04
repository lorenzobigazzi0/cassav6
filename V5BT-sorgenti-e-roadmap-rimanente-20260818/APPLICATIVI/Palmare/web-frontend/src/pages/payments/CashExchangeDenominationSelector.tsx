import { formatCurrency } from "../../shared/format/currency";
import type {
  CashExchangeAvailableDenomination,
  CashExchangePieces,
} from "../../types/cashExchange";
import {
  CASH_EXCHANGE_DENOMINATIONS,
  decrementCashExchangePiece,
  incrementCashExchangePiece,
  normalizeCashExchangeAvailableDenominations,
  sumCashExchangePieces,
} from "./cashExchangeDenominations";

type CashExchangeDenominationSelectorProps = {
  depositedCents: number;
  pieces: CashExchangePieces;
  allowedDenominationsCents?: number[];
  availableDenominations?: CashExchangeAvailableDenomination[];
  onChange: (pieces: CashExchangePieces) => void;
  disabled?: boolean;
};

const formatCents = (value: number) => formatCurrency(Math.max(0, value) / 100);

export function CashExchangeDenominationSelector({
  depositedCents,
  pieces,
  allowedDenominationsCents = [],
  availableDenominations = [],
  onChange,
  disabled = false,
}: CashExchangeDenominationSelectorProps) {
  const selectedTotalCents = sumCashExchangePieces(pieces);
  const remainingCents = Math.max(0, depositedCents - selectedTotalCents);
  const normalizedAvailability = normalizeCashExchangeAvailableDenominations(availableDenominations);
  const availabilityByCents = new Map(
    normalizedAvailability.map((entry) => [entry.cents, entry])
  );
  const allowedSet = new Set(allowedDenominationsCents);
  const denominations = normalizedAvailability.length
    ? normalizedAvailability.map((entry) => ({
        cents: entry.cents,
        label:
          entry.label ??
          CASH_EXCHANGE_DENOMINATIONS.find((denomination) => denomination.cents === entry.cents)
            ?.label ??
          formatCents(entry.cents),
      }))
    : allowedSet.size
      ? CASH_EXCHANGE_DENOMINATIONS.filter((denomination) => allowedSet.has(denomination.cents))
      : CASH_EXCHANGE_DENOMINATIONS;

  return (
    <div className="cash-exchange-selector">
      <div className="cash-exchange-summary">
        <div>
          <span>Totale da cambiare</span>
          <strong>{formatCents(depositedCents)}</strong>
        </div>
        <div>
          <span>Selezionato</span>
          <strong>{formatCents(selectedTotalCents)}</strong>
        </div>
        <div className={remainingCents === 0 ? "is-complete" : "is-pending"}>
          <span>Residuo</span>
          <strong>{formatCents(remainingCents)}</strong>
        </div>
      </div>

      <div className="cash-exchange-denomination-list">
        {denominations.map((denomination) => {
          const key = String(denomination.cents);
          const quantity = Math.max(0, Math.trunc(pieces[key] || 0));
          const lineTotalCents = quantity * denomination.cents;
          const availability = availabilityByCents.get(denomination.cents);
          const maxPieces = availability
            ? Math.max(0, Math.trunc(availability.availablePieces))
            : Number.POSITIVE_INFINITY;
          const canDecrement = !disabled && quantity > 0;
          const canIncrement =
            !disabled &&
            quantity < maxPieces &&
            selectedTotalCents + denomination.cents <= depositedCents;

          return (
            <div className="cash-exchange-denomination-row" key={denomination.cents}>
              <button
                type="button"
                className="smallbtn cash-exchange-stepper"
                disabled={!canDecrement}
                aria-label={`Rimuovi ${denomination.label}`}
                onClick={() => onChange(decrementCashExchangePiece(pieces, denomination.cents))}
              >
                -
              </button>
              <div className="cash-exchange-denomination-label">
                <strong>{denomination.label}</strong>
                <span>
                  x {quantity} = {formatCents(lineTotalCents)}
                </span>
                {availability ? (
                  <em className="cash-exchange-denomination-badge">
                    Erogabili {maxPieces}
                  </em>
                ) : null}
              </div>
              <button
                type="button"
                className="smallbtn cash-exchange-stepper"
                disabled={!canIncrement}
                aria-label={`Aggiungi ${denomination.label}`}
                onClick={() =>
                  onChange(
                    incrementCashExchangePiece(
                      pieces,
                      denomination.cents,
                      depositedCents,
                      maxPieces
                    )
                  )
                }
              >
                +
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
