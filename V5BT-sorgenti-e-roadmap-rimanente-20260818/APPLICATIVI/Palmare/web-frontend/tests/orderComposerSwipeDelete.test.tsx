import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuCatalog, MenuProduct } from "../src/api/menu";
import { fetchTopSoldProducts } from "../src/api/topSoldProducts";
import { TableOrderComposer } from "../src/pages/home/tables/components/TableOrderComposer";

vi.mock("../src/api/stations", () => ({
  fetchActiveStationCount: vi.fn(async () => 1),
}));

vi.mock("../src/api/topSoldProducts", () => ({
  fetchTopSoldProducts: vi.fn(async () => []),
}));

const waterProduct: MenuProduct = {
  id: "water",
  sku: "water",
  departmentId: "dept_drinks",
  categoryId: "cat_drinks",
  name: "Acqua",
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 2,
  imageUrl: null,
};

const wineProduct: MenuProduct = {
  ...waterProduct,
  id: "wine",
  sku: "wine",
  name: "Vino",
  price: 5,
};

const catalog: MenuCatalog = {
  departments: [{ id: "dept_drinks", name: "Bevande" }],
  categories: [{ id: "cat_drinks", departmentId: "dept_drinks", name: "Bevande" }],
  products: [waterProduct, wineProduct],
};

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(fetchTopSoldProducts).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("order composer swipe delete", () => {
  it("reveals the trash action and removes the item only after it is pressed", () => {
    const { container } = render(
      <TableOrderComposer
        open
        busy={false}
        catalog={catalog}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
      />
    );

    fireEvent.click(screen.getByText("Acqua").closest("button")!);
    fireEvent.click(screen.getByText("Vino").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /Comanda \(2\)/ }));

    const swipeRow = container.querySelector<HTMLElement>(".table-order-swipe-row");
    expect(swipeRow).not.toBeNull();
    swipeRow!.setPointerCapture = vi.fn();

    fireEvent.pointerDown(swipeRow!, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 200,
      clientY: 20,
      button: 0,
    });
    fireEvent.pointerMove(swipeRow!, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 80,
      clientY: 20,
    });
    fireEvent.pointerUp(swipeRow!, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 80,
      clientY: 20,
    });

    expect(container.querySelector(".table-order-swipe-row")).toBeInTheDocument();
    expect(container.querySelector(".table-order-delete-backdrop")).not.toBeInTheDocument();

    fireEvent.click(swipeRow!.querySelector<HTMLButtonElement>(".table-order-swipe-hit")!);

    expect(container.querySelectorAll(".table-order-swipe-row")).toHaveLength(1);
    expect(container.querySelector(".table-order-swipe-row.is-reflow")).not.toBeInTheDocument();
    expect(container.querySelector(".table-order-swipe-row")).toHaveTextContent("Vino");
  });

  it.each(["Nuova Comanda", "Ordine Banco"])(
    "shows a yellow rank star on article cards in %s",
    async (title) => {
      vi.mocked(fetchTopSoldProducts).mockResolvedValue([
        {
          rank: 1,
          productId: "wine",
          name: "Vino",
          category: "Bevande",
          quantity: 12,
          revenue: 60,
          lastSoldAt: "2026-07-19T00:00:00.000Z",
          source: "payments",
        },
      ]);

      const { container } = render(
        <TableOrderComposer
          open
          busy={false}
          catalog={catalog}
          title={title}
          onClose={vi.fn()}
          onSubmit={vi.fn(async () => undefined)}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Attiva best-seller" }));

      await waitFor(() => {
        expect(screen.getByLabelText("Best-seller n. 1")).toBeInTheDocument();
      });
      expect(screen.getByText("Vino").closest("button")).toHaveClass("is-best-seller");
      expect(screen.getByText("Acqua")).toBeInTheDocument();
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>(
            ".table-order-products-main > .table-order-product-row .table-order-product-name"
          )
        ).map((element) => element.textContent)
      ).toEqual(["Varie", "Vino", "Acqua"]);
      expect(container.querySelectorAll(".table-order-product-best-seller-star")).toHaveLength(1);
    }
  );
});
