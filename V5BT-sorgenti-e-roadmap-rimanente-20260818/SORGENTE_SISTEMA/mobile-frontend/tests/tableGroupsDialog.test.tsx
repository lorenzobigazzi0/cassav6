import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DiningTable } from "../src/api/tables";
import { TableGroupsDialog } from "../src/pages/home/tables/components/TableGroupsDialog";

const makeTable = (id: string, number: number, amountDue = 0): DiningTable =>
  ({
    id,
    number,
    tableName: `Tavolo ${number}`,
    customerPhone: "",
    covers: 2,
    occupancyState: amountDue > 0 ? "seated" : "free",
    reservationAt: null,
    seatedAt: amountDue > 0 ? Date.now() : null,
    ordersTaken: amountDue > 0 ? 1 : 0,
    ordersInProgress: 0,
    amountDue,
    note: "",
    allergens: [],
    manualIntolerance: "",
    orderHistory: [],
  }) as DiningTable;

afterEach(() => cleanup());

describe("TableGroupsDialog context", () => {
  it("allinea il nome del tavolo a destra del pulsante chiudi", () => {
    render(
      <TableGroupsDialog
        state={{ type: "context", tableId: "t7" }}
        tables={[makeTable("t7", 7)]}
        groups={[]}
        rooms={[]}
        currentRoomId="room_pedana"
        roomMoveTables={[]}
        roomMoveGroups={[]}
        roomMoveAvailability={new Map()}
        roomMoveAvailabilityLoading={false}
        roomMoveAvailabilityReady={false}
        roomsLoading={false}
        roomMoveTablesLoading={false}
        busy={false}
        error={null}
        onClose={vi.fn()}
        onChangeState={vi.fn()}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onMove={vi.fn()}
        onChooseRoomMoveRoom={vi.fn()}
        onRoomMove={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Azioni tavolo" });
    const header = dialog.querySelector(".mobile-table-groups-context-head");
    expect(header).not.toBeNull();
    expect(header?.children[0]).toBe(screen.getByRole("button", { name: "Chiudi" }));
    expect(header?.children[1]).toHaveTextContent("Tavolo 7");
  });
});

describe("TableGroupsDialog merge", () => {
  it("permette di selezionare piu tavoli e mantiene stabili i badge di conferma", () => {
    const onMerge = vi.fn();

    render(
      <TableGroupsDialog
        state={{ type: "merge", tableId: "t1" }}
        tables={[
          makeTable("t1", 1, 12),
          makeTable("t2", 2, 8),
          makeTable("t3", 3, 6),
          makeTable("t4", 4),
        ]}
        groups={[]}
        rooms={[]}
        currentRoomId="room_pedana"
        roomMoveTables={[]}
        roomMoveGroups={[]}
        roomMoveAvailability={new Map()}
        roomMoveAvailabilityLoading={false}
        roomMoveAvailabilityReady={false}
        roomsLoading={false}
        roomMoveTablesLoading={false}
        busy={false}
        error={null}
        onClose={vi.fn()}
        onChangeState={vi.fn()}
        onMerge={onMerge}
        onSplit={vi.fn()}
        onMove={vi.fn()}
        onChooseRoomMoveRoom={vi.fn()}
        onRoomMove={vi.fn()}
      />
    );

    const mainRow = screen.getByRole("button", { name: /Tavolo 1/i });
    expect(within(mainRow).queryByText("CONFERMA")).not.toBeInTheDocument();
    expect(screen.queryAllByText("CONFERMA")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Tavolo 2/i }));

    expect(screen.queryAllByText("CONFERMA")).toHaveLength(2);
    expect(screen.queryByText("NON DISPONIBILE")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tavolo 3/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Tavolo 3/i }));
    fireEvent.click(screen.getByRole("button", { name: /Tavolo 4/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Unisci$/i }));

    expect(onMerge).toHaveBeenCalledWith("t1", ["t2", "t3", "t4"], {
      requiresActiveConfirmation: true,
    });
  });
});

describe("TableGroupsDialog cambio sala", () => {
  const commonProps = {
    tables: [makeTable("t1", 1, 12)],
    groups: [],
    rooms: [
      { id: "room_current", name: "Pedana" },
      { id: "room_garden", name: "Giardino" },
      { id: "room_hall", name: "Sala interna" },
      { id: "room_roof", name: "Terrazza" },
    ],
    currentRoomId: "room_current",
    roomMoveTables: [],
    roomMoveGroups: [],
    roomsLoading: false,
    roomMoveTablesLoading: false,
    busy: false,
    error: null,
    onClose: vi.fn(),
    onChangeState: vi.fn(),
    onMerge: vi.fn(),
    onSplit: vi.fn(),
    onMove: vi.fn(),
    onChooseRoomMoveRoom: vi.fn(),
    onRoomMove: vi.fn(),
  };

  it("mostra disponibilita, singolare e stato piena per ogni sala", () => {
    const onChooseRoomMoveRoom = vi.fn();

    render(
      <TableGroupsDialog
        {...commonProps}
        state={{ type: "roomMoveRoom", tableId: "t1" }}
        roomMoveAvailability={
          new Map([
            ["room_garden", { freeCount: 2, totalCount: 17 }],
            ["room_hall", { freeCount: 1, totalCount: 8 }],
            ["room_roof", { freeCount: 0, totalCount: 12 }],
          ])
        }
        roomMoveAvailabilityLoading={false}
        roomMoveAvailabilityReady
        onChooseRoomMoveRoom={onChooseRoomMoveRoom}
      />
    );

    expect(screen.getByText("Liberi 2/17")).toBeInTheDocument();
    expect(screen.getByText("Libero 1/8")).toBeInTheDocument();
    expect(screen.getByText("Piena")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Giardino.*Liberi 2\/17/i }));
    expect(onChooseRoomMoveRoom).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ id: "room_garden" })
    );
    expect(screen.getByRole("button", { name: /Terrazza.*Piena/i })).toBeDisabled();
  });

  it("torna alla lista sale dal pulsante indietro nell'header", () => {
    const onChangeState = vi.fn();

    render(
      <TableGroupsDialog
        {...commonProps}
        state={{ type: "roomMoveTable", tableId: "t1", targetRoomId: "room_garden" }}
        roomMoveAvailability={new Map()}
        roomMoveAvailabilityLoading={false}
        roomMoveAvailabilityReady
        onChangeState={onChangeState}
      />
    );

    const backButton = screen.getByRole("button", { name: "Torna alla lista sale" });
    expect(backButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(backButton);

    expect(onChangeState).toHaveBeenCalledWith({ type: "roomMoveRoom", tableId: "t1" });
  });
});
