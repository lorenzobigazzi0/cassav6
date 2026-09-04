import { describe, expect, it } from "vitest";
import type { DiningTable, DiningTableMoveResult, TablesSnapshot } from "../src/api/tables";
import {
  applyOptimisticFreeTableToSnapshot,
  applyOptimisticMoveTablesBetweenSnapshots,
  applyOptimisticMoveTablesToSnapshot,
  applyOptimisticOccupyTableToSnapshot,
  applyOptimisticOrderPendingToSnapshot,
  applyResolvedTableMoveToSnapshot,
  resolveTableMoveLockIds,
} from "../src/pages/home/tables/workspaceRuntime";

const makeTable = (overrides: Partial<DiningTable> = {}): DiningTable => ({
  id: "table_1",
  number: 1,
  tableName: "",
  customerPhone: "",
  covers: 0,
  occupancyState: "free",
  reservationAt: null,
  seatedAt: null,
  ordersTaken: 0,
  ordersInProgress: 0,
  amountDue: 0,
  note: "",
  allergens: [],
  manualIntolerance: "",
  orderHistory: [],
  ...overrides,
});

const makeSnapshot = (table: DiningTable): TablesSnapshot => ({
  version: 1,
  tables: [table],
  rawTables: [table],
  tableGroups: [],
});

describe("tables optimistic workspace patches", () => {
  it("non richiede il lock della sorgente tombstone ma mantiene quello della destinazione", () => {
    const removedSource = makeTable({
      occupancyState: "seated",
      offlineLifecycle: {
        state: "removed_while_active",
        removedAt: 200,
        removedFromLayoutVersion: 2,
        usableUntil: "released",
        requiresDecision: false,
        decision: "keep",
      },
    });
    const target = makeTable({ id: "table_2", number: 2 });

    expect(resolveTableMoveLockIds([removedSource, target], [removedSource.id], [target.id])).toEqual([
      target.id,
    ]);
    expect(resolveTableMoveLockIds([makeTable(), target], ["table_1"], [target.id])).toEqual([
      "table_1",
      target.id,
    ]);
  });

  it("occupa subito il tavolo nella snapshot senza mutare quella precedente", () => {
    const sourceTable = makeTable();
    const source = makeSnapshot(sourceTable);

    const result = applyOptimisticOccupyTableToSnapshot(
      source,
      "table_1",
      {
        tableName: "Mario",
        customerPhone: "333",
        covers: 3,
        note: "Nota",
        allergens: ["Glutine"],
        manualIntolerance: "Piccante",
      },
      1_800_000_000_000
    );

    expect(source.tables[0].occupancyState).toBe("free");
    expect(result.table).toMatchObject({
      id: "table_1",
      occupancyState: "seated",
      tableName: "Mario",
      customerPhone: "333",
      covers: 3,
      note: "Nota",
      allergens: ["Glutine"],
      manualIntolerance: "Piccante",
      reservationAt: null,
      seatedAt: 1_800_000_000_000,
    });
    expect(result.snapshot?.version).toBe(2);
    expect(result.snapshot?.tables[0]).toEqual(result.table);
    expect(result.snapshot?.rawTables?.[0]).toEqual(result.table);
  });

  it("libera subito il tavolo cancellando dati operativi visuali", () => {
    const source = makeSnapshot(
      makeTable({
        tableName: "Mario",
        customerPhone: "333",
        covers: 4,
        occupancyState: "seated",
        seatedAt: 1_800_000_000_000,
        ordersTaken: 1,
        ordersInProgress: 0,
        amountDue: 0,
        note: "Nota",
        allergens: ["Latte"],
        manualIntolerance: "Noci",
        orderHistory: [
          {
            id: "order_1",
            title: "Comanda 1",
            createdAt: 1,
            total: 10,
            state: "paid",
            paidArticleUnits: [],
            lines: [],
          },
        ],
      })
    );

    const result = applyOptimisticFreeTableToSnapshot(source, "table_1");

    expect(result.table).toMatchObject({
      id: "table_1",
      occupancyState: "free",
      tableName: "",
      customerPhone: "",
      covers: 0,
      note: "",
      allergens: [],
      manualIntolerance: "",
      reservationAt: null,
      seatedAt: null,
      ordersTaken: 0,
      ordersInProgress: 0,
      amountDue: 0,
      orderHistory: [],
      reservationPreview: null,
    });
    expect(source.tables[0].occupancyState).toBe("seated");
    expect(source.tables[0].orderHistory).toHaveLength(1);
  });

  it("rimuove dalla snapshot un tavolo dismesso quando viene liberato", () => {
    const source = makeSnapshot(
      makeTable({
        occupancyState: "reserved",
        reservationAt: 100,
        offlineLifecycle: {
          state: "removed_while_active",
          removedAt: 200,
          removedFromLayoutVersion: 2,
          usableUntil: "released",
          requiresDecision: false,
          decision: "keep",
        },
      })
    );

    const result = applyOptimisticFreeTableToSnapshot(source, "table_1");

    expect(result.table).toBeNull();
    expect(result.snapshot?.tables).toEqual([]);
    expect(result.snapshot?.rawTables).toEqual([]);
    expect(source.tables).toHaveLength(1);
  });

  it("aggiunge subito una comanda in attesa senza rendere pagabile il tavolo", () => {
    const source = makeSnapshot(
      makeTable({
        tableName: "Mario",
        covers: 2,
        occupancyState: "seated",
        seatedAt: 1_800_000_000_000,
        ordersTaken: 1,
        ordersInProgress: 0,
        amountDue: 0,
      })
    );

    const result = applyOptimisticOrderPendingToSnapshot(
      source,
      "table_1",
      {
        title: "1x Espresso",
        total: 1.2,
        orderNote: "Banco",
        lines: [{ productId: "espresso", name: "Espresso", qty: 1, unitFinalPrice: 1.2 }],
      },
      1_800_000_100_000
    );

    expect(source.tables[0].orderHistory).toHaveLength(0);
    expect(result.table).toMatchObject({
      id: "table_1",
      occupancyState: "seated",
      ordersTaken: 2,
      ordersInProgress: 1,
      amountDue: 0,
    });
    expect(result.table?.orderHistory[0]).toMatchObject({
      id: "optimistic_order_table_1_1800000100000",
      title: "1x Espresso",
      createdAt: 1_800_000_100_000,
      total: 1.2,
      state: "in_progress",
      workflowStatus: "waiting",
      orderNote: "Banco",
      lines: [{ productId: "espresso", name: "Espresso", qty: 1, unitFinalPrice: 1.2 }],
    });
    expect(result.snapshot?.version).toBe(2);
    expect(result.snapshot?.tables[0]).toEqual(result.table);
    expect(result.snapshot?.rawTables?.[0]).toEqual(result.table);
  });

  it("sposta subito un tavolo nella stessa sala", () => {
    const source = makeSnapshot(
      makeTable({
        tableName: "Mario",
        covers: 2,
        occupancyState: "seated",
        seatedAt: 1_800_000_000_000,
        amountDue: 12,
        orderHistory: [
          {
            id: "order_1",
            title: "Comanda 1",
            createdAt: 1,
            total: 12,
            state: "served",
            paidArticleUnits: [],
            lines: [],
          },
        ],
      })
    );
    source.tables.push(makeTable({ id: "table_2", number: 2 }));
    source.rawTables?.push(makeTable({ id: "table_2", number: 2 }));

    const result = applyOptimisticMoveTablesToSnapshot(source, [
      { sourceId: "table_1", targetId: "table_2" },
    ]);

    const movedFrom = result.snapshot?.tables.find((table) => table.id === "table_1");
    const movedTo = result.snapshot?.tables.find((table) => table.id === "table_2");
    expect(result.moves).toHaveLength(1);
    expect(movedFrom).toMatchObject({
      occupancyState: "free",
      tableName: "",
      amountDue: 0,
      orderHistory: [],
    });
    expect(movedTo).toMatchObject({
      occupancyState: "seated",
      tableName: "Mario",
      covers: 2,
      amountDue: 12,
    });
    expect(movedTo?.orderHistory).toHaveLength(1);
    expect(source.tables[0].occupancyState).toBe("seated");
  });

  it("sposta subito un tavolo tra due snapshot di sale diverse", () => {
    const sourceSnapshot = makeSnapshot(
      makeTable({
        tableName: "Mario",
        covers: 2,
        occupancyState: "seated",
        seatedAt: 1_800_000_000_000,
      })
    );
    const targetSnapshot = makeSnapshot(makeTable({ id: "target_1", number: 9 }));

    const result = applyOptimisticMoveTablesBetweenSnapshots(sourceSnapshot, targetSnapshot, [
      { sourceId: "table_1", targetId: "target_1" },
    ]);

    expect(result.moves).toHaveLength(1);
    expect(result.sourceSnapshot?.tables[0]).toMatchObject({
      id: "table_1",
      occupancyState: "free",
      tableName: "",
    });
    expect(result.targetSnapshot?.tables[0]).toMatchObject({
      id: "target_1",
      number: 9,
      occupancyState: "seated",
      tableName: "Mario",
      covers: 2,
    });
    expect(sourceSnapshot.tables[0].occupancyState).toBe("seated");
    expect(targetSnapshot.tables[0].occupancyState).toBe("free");
  });

  it("non reinserisce la sorgente dismessa dopo la risposta allo spostamento", () => {
    const sourceTable = makeTable({
      occupancyState: "reserved",
      reservationAt: 100,
      offlineLifecycle: {
        state: "removed_while_active",
        removedAt: 200,
        removedFromLayoutVersion: 2,
        usableUntil: "released",
        requiresDecision: false,
        decision: "keep",
      },
    });
    const targetTable = makeTable({ id: "table_2", number: 2 });
    const snapshot = makeSnapshot(sourceTable);
    snapshot.tables.push(targetTable);
    snapshot.rawTables?.push(targetTable);
    const result: DiningTableMoveResult = {
      movedFrom: makeTable(),
      movedTo: makeTable({
        id: "table_2",
        number: 2,
        tableName: "Mario",
        occupancyState: "reserved",
        reservationAt: 100,
      }),
      removedSourceTableId: "table_1",
    };

    const updated = applyResolvedTableMoveToSnapshot(snapshot, result);

    expect(updated?.tables.map((table) => table.id)).toEqual(["table_2"]);
    expect(updated?.rawTables?.map((table) => table.id)).toEqual(["table_2"]);
    expect(updated?.tables[0]).toMatchObject({
      tableName: "Mario",
      occupancyState: "reserved",
      reservationAt: 100,
    });
  });
});
