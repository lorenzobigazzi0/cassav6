import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuCatalog, MenuProduct } from "../src/api/menu";
import { TableOrderComposer } from "../src/pages/home/tables/components/TableOrderComposer";

vi.mock("../src/api/stations", () => ({
  fetchActiveStationCount: vi.fn(async () => 1),
}));

vi.mock("../src/api/topSoldProducts", () => ({
  fetchTopSoldProducts: vi.fn(async () => []),
}));

const product: MenuProduct = {
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

const catalog: MenuCatalog = {
  departments: [{ id: "dept_drinks", name: "Bevande" }],
  categories: [{ id: "cat_drinks", departmentId: "dept_drinks", name: "Bevande" }],
  products: [product],
};

afterEach(() => cleanup());

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
    fireEvent.click(screen.getByRole("button", { name: /Comanda \(1\)/ }));

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

    fireEvent.click(screen.getByRole("button", { name: "Elimina articolo" }));

    expect(container.querySelector(".table-order-swipe-row")).not.toBeInTheDocument();
  });
});
