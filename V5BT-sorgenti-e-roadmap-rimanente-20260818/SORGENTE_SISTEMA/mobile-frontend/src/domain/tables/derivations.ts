import type { DiningTable, DiningTableVisualState, PosTableStatus } from "./types";

export const derivePosStatusFromDiningTable = (table: DiningTable): PosTableStatus => {
  if (table.occupancyState === "free") return "free";
  if (table.occupancyState === "reserved") return "reserved";
  if (table.amountDue > 0) return "payment_due";
  if (table.ordersInProgress > 0) return "waiting";
  return "no_orders";
};

export const deriveTableVisualState = (table: DiningTable): DiningTableVisualState => {
  if (table.amountDue > 0) return "payment_due";
  if (table.ordersInProgress > 0) return "ordering";
  if (table.occupancyState === "free") return "free";
  return "occupied";
};
