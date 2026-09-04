import {
  sanitizeCashMovement,
  sumCashMovementPieces,
} from "./cash-movement.domain.js";

const LINE_WIDTH = 42;

function line(character = "-") {
  return character.repeat(LINE_WIDTH);
}

function money(cents) {
  return `${(Math.max(0, Number(cents) || 0) / 100).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} EUR`;
}

function timestamp(value) {
  const date = new Date(Number(value) || Date.now());
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function denominationRows(pieces) {
  return Object.entries(pieces ?? {})
    .map(([rawCents, rawQuantity]) => ({
      cents: Number(rawCents),
      quantity: Number(rawQuantity),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.cents) &&
        entry.cents > 0 &&
        Number.isInteger(entry.quantity) &&
        entry.quantity > 0,
    )
    .sort((left, right) => right.cents - left.cents)
    .map(
      (entry) =>
        `${money(entry.cents).padEnd(12)} x ${String(entry.quantity).padStart(3)}  ${money(
          entry.cents * entry.quantity,
        ).padStart(14)}`,
    );
}

export function buildCashMovementReportText(movement) {
  const safe = sanitizeCashMovement(movement);
  if (!safe) throw new Error("Movimento cassa non valido per il report.");
  const typeLabel =
    safe.type === "load" ? "REPORT CARICAMENTO" : "REPORT PRELIEVO";
  const rows = denominationRows(safe.pieces);
  const totalCents =
    sumCashMovementPieces(safe.pieces) ||
    safe.amountCents ||
    safe.requestedAmountCents;
  return [
    line("="),
    "CASSA AUTOMATICA",
    typeLabel,
    line("="),
    `Data: ${timestamp(
      safe.physicalCompletedAtMs ??
        safe.completedAtMs ??
        safe.updatedAtMs,
    )}`,
    `Operatore: ${safe.ownerFullName || safe.ownerUserId || "Operatore"}`,
    safe.roomName ? `Sala: ${safe.roomName}` : "",
    `Movimento: ${safe.movementId}`,
    line(),
    "TAGLI",
    ...(rows.length > 0 ? rows : ["Dettaglio tagli non fornito dal gateway"]),
    line(),
    `TOTALE: ${money(totalCents)}`,
    line(),
    `Motivo: ${safe.justification || "-"}`,
    line("="),
    "",
    "",
  ]
    .filter((entry) => entry !== "")
    .join("\n");
}
