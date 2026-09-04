import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DiningTable, DiningTableOrder } from "../src/api/tables";
import { AdminPaymentAdjustmentDialog } from "../src/pages/home/tables/components/AdminPaymentAdjustmentDialog";

const makeOrder = (patch: Partial<DiningTableOrder>): DiningTableOrder => ({
  id: "order_served",
  title: "Comanda servita",
  createdAt: 1000,
  total: 2.6,
  dueAmount: 2.6,
  state: "served",
  workflowStatus: "delivered",
  paymentStatus: "unpaid",
  paidArticleUnits: [],
  lines: [{ name: "Acqua naturale 0,5", qty: 2, unitFinalPrice: 1.3 }],
  ...patch,
});

const makeTable = (): DiningTable =>
  ({
    id: "table_1",
    number: 1,
    tableName: "Tavolo 1",
    customerPhone: "",
    covers: 2,
    occupancyState: "seated",
    reservationAt: null,
    seatedAt: Date.now(),
    ordersTaken: 2,
    ordersInProgress: 1,
    amountDue: 12.6,
    note: "",
    allergens: [],
    manualIntolerance: "",
    orderHistory: [
      makeOrder({ id: "served", title: "Servita" }),
      makeOrder({
        id: "waiting",
        title: "Non consegnata",
        total: 10,
        dueAmount: 10,
        state: "in_progress",
        workflowStatus: "prep",
        lines: [{ name: "Hamburger", qty: 1, unitFinalPrice: 10 }],
      }),
    ],
  }) as DiningTable;

afterEach(() => {
  cleanup();
});

describe("AdminPaymentAdjustmentDialog", () => {
  it("inizializza l'abbuono a zero quando si seleziona la modalita", () => {
    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Importo/i }));
    fireEvent.click(screen.getByRole("option", { name: /Abbuono/i }));

    expect(screen.getByLabelText("Importo abbuono")).toHaveValue("0");
    expect(screen.getByRole("button", { name: /^APPLICA$/i })).toBeDisabled();
  });

  it("rettifica solo articoli consegnati e aggiorna il subtotale della riga", () => {
    const onApply = vi.fn();

    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Importo/i }));
    fireEvent.click(screen.getByRole("option", { name: /Articoli/i }));

    expect(screen.getByText(/Acqua naturale 0,5/)).toBeInTheDocument();
    expect(screen.queryByText("Hamburger")).not.toBeInTheDocument();

    const row = screen.getByText("Quantità 2").closest(".admin-payment-line-row");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/Subtotale/i).parentElement).toHaveTextContent(
      /2,60/
    );

    fireEvent.change(screen.getByLabelText("Importo Acqua naturale 0,5"), {
      target: { value: "1,00" },
    });

    expect(within(row as HTMLElement).getByText(/Subtotale/i).parentElement).toHaveTextContent(
      /2,00/
    );

    fireEvent.click(screen.getByRole("button", { name: /^APPLICA$/i }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [payload, options] = onApply.mock.calls[0];
    expect(options).toEqual({ collectNow: false });
    expect(payload).toMatchObject({
      amount: 2,
      articleUnitIds: ["served_0_0", "served_0_1"],
      splitMode: "article",
      adminAdjustment: {
        originalAmount: 2.6,
        adjustedAmount: 2,
        discountAmount: 0.6,
      },
    });
    expect(payload.adminAdjustment.lineAdjustments).toHaveLength(2);
    expect(payload.adminAdjustment.lineAdjustments[0]).toMatchObject({
      name: "Acqua naturale 0,5",
      originalAmount: 1.3,
      adjustedAmount: 1,
    });
  });

  it("disabilita entrambe le azioni mentre attende il salvataggio reale", async () => {
    let completeSave: (() => void) | undefined;
    const onApply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeSave = resolve;
        })
    );

    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );

    fireEvent.change(screen.getByLabelText("Totale da riscuotere"), {
      target: { value: "2,00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^APPLICA$/i }));

    expect(screen.getByRole("button", { name: /SALVATAGGIO/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /APPLICA E RISCUOTI/i })).toBeDisabled();
    expect(onApply).toHaveBeenCalledTimes(1);

    completeSave?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^APPLICA$/i })).not.toBeDisabled()
    );
  });

  it("non chiude e mostra l'errore reale quando il salvataggio fallisce", async () => {
    const onClose = vi.fn();
    const onApply = vi.fn().mockRejectedValue(new Error("Conflitto revisione comanda"));

    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={onClose}
        onApply={onApply}
      />
    );

    fireEvent.change(screen.getByLabelText("Totale da riscuotere"), {
      target: { value: "2,00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^APPLICA$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Conflitto revisione comanda");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /Rettifica pagamento admin/i })).toBeInTheDocument();
  });

  it("APPLICA E RISCUOTI richiede prima il salvataggio con collectNow", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );

    fireEvent.change(screen.getByLabelText("Totale da riscuotere"), {
      target: { value: "2,00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /APPLICA E RISCUOTI/i }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]?.[1]).toEqual({ collectNow: true });
  });

  it("consente l'azzeramento con APPLICA ma non apre una riscossione a zero", () => {
    const onApply = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );

    fireEvent.change(screen.getByLabelText("Totale da riscuotere"), {
      target: { value: "0" },
    });

    expect(screen.getByRole("button", { name: /^APPLICA$/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /APPLICA E RISCUOTI/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^APPLICA$/i }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ amount: 0 }), {
      collectNow: false,
    });
  });

  it("rifiuta importi non numerici senza trasformarli in zero", () => {
    render(
      <AdminPaymentAdjustmentDialog
        open
        table={makeTable()}
        busy={false}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Totale da riscuotere"), {
      target: { value: "abc" },
    });

    expect(screen.getByRole("button", { name: /^APPLICA$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /APPLICA E RISCUOTI/i })).toBeDisabled();
  });
});
