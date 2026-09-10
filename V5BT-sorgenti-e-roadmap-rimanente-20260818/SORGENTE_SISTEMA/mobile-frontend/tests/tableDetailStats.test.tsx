import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TableDetailStats } from "../src/pages/home/tables/components/TableDetailStats";

afterEach(cleanup);

describe("TableDetailStats", () => {
  it("mostra titolo sopra e icona con valore nella riga inferiore", () => {
    const { container } = render(
      <TableDetailStats ordersTaken={12} ordersInProgress={3} amountDue={45.6} />
    );

    expect(screen.getByText("PRESI")).toBeInTheDocument();
    expect(screen.getByText("IN CORSO")).toBeInTheDocument();
    expect(screen.getByText("DA RISCUOTERE")).toBeInTheDocument();

    const cards = container.querySelectorAll(".table-detail-stat");
    expect(cards).toHaveLength(3);
    cards.forEach((card) => {
      expect(card.firstElementChild).toHaveClass("table-detail-stat-label");
      expect(card.lastElementChild).toHaveClass("table-detail-stat-text");
      expect(card.lastElementChild?.firstElementChild).toHaveClass("table-detail-stat-icon");
      expect(card.lastElementChild?.lastElementChild).toHaveClass("table-detail-stat-value");
    });
  });
});
