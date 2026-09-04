import type { DiningTable } from "../../../api/tables";
import { tableGroupContainingId, type TableGroup } from "../../../api/tableGroups";
import { flattenTableGroupNodeIds } from "../../../api/tableGroups";

export type UnionReadiness = {
  /** Tavoli della prenotazione trovati in sala. */
  assigned: DiningTable[];
  /** Id assegnati che non esistono in questa sala. */
  missing: string[];
  /** Occupati ma liberabili: nessun ordine aperto, niente da riscuotere. */
  toFree: DiningTable[];
  /** In ordine o da pagare: vanno sistemati a mano, non si possono liberare. */
  blocked: DiningTable[];
  /** Gia' dentro un gruppo diverso da quello della prenotazione. */
  conflicting: DiningTable[];
  /** L'unione e' gia' esattamente quella prevista dalla prenotazione. */
  alreadyUnited: boolean;
  /** Tutto libero e senza conflitti: l'unione si puo' formare da sola. */
  ready: boolean;
};

const sameIdSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().join("|") === [...right].sort().join("|");

export function evaluateUnionReadiness(
  tables: readonly DiningTable[],
  assignedTableIds: readonly string[],
  groups: readonly TableGroup[]
): UnionReadiness {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const assigned: DiningTable[] = [];
  const missing: string[] = [];
  for (const id of assignedTableIds) {
    const table = byId.get(id);
    if (table) assigned.push(table);
    else missing.push(id);
  }

  const toFree = assigned.filter(
    (table) =>
      table.occupancyState !== "free" && table.ordersInProgress <= 0 && table.amountDue <= 0
  );
  const blocked = assigned.filter(
    (table) => table.ordersInProgress > 0 || table.amountDue > 0
  );

  const conflicting = assigned.filter((table) => {
    const group = tableGroupContainingId(groups as TableGroup[], table.id);
    if (!group) return false;
    return !sameIdSet(flattenTableGroupNodeIds(group), assignedTableIds);
  });

  const alreadyUnited =
    assignedTableIds.length > 1 &&
    assigned.length === assignedTableIds.length &&
    assigned.every((table) => {
      const group = tableGroupContainingId(groups as TableGroup[], table.id);
      return Boolean(group) && sameIdSet(flattenTableGroupNodeIds(group!), assignedTableIds);
    });

  return {
    assigned,
    missing,
    toFree,
    blocked,
    conflicting,
    alreadyUnited,
    ready:
      assignedTableIds.length > 1 &&
      missing.length === 0 &&
      toFree.length === 0 &&
      blocked.length === 0 &&
      conflicting.length === 0 &&
      !alreadyUnited,
  };
}

export const tableLabelsOf = (tables: readonly DiningTable[]) =>
  tables.map((table) => table.mobileComplexLabel || `Tavolo ${table.number}`);

/** Esito del controllo prima di accomodare una prenotazione su piu' tavoli. */
export type SeatGuardResult =
  | { ok: true }
  | {
      ok: false;
      /** In ordine o da pagare: vanno sistemati a mano, non si liberano da qui. */
      blockedLabels: string[];
      /** Solo occupati: si possono liberare al volo, previa conferma. */
      freeableIds: string[];
      freeableLabels: string[];
      /** Gia' uniti ad altri tavoli: prima va sciolto quel gruppo. */
      conflictLabels: string[];
    };

export function seatGuardFor(readiness: UnionReadiness): SeatGuardResult {
  if (
    readiness.blocked.length === 0 &&
    readiness.toFree.length === 0 &&
    readiness.conflicting.length === 0
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    blockedLabels: tableLabelsOf(readiness.blocked),
    freeableIds: readiness.toFree.map((table) => table.id),
    freeableLabels: tableLabelsOf(readiness.toFree),
    conflictLabels: tableLabelsOf(readiness.conflicting),
  };
}
