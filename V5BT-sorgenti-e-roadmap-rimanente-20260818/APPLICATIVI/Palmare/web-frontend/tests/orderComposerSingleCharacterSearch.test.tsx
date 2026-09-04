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

const product = (id: string, name: string, categoryId: string): MenuProduct => ({
  id,
  sku: id,
  departmentId: "dept_drinks",
  categoryId,
  name,
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 6,
  imageUrl: null,
});

const catalog: MenuCatalog = {
  departments: [{ id: "dept_drinks", name: "Bevande" }],
  categories: [
    { id: "cat_wine", departmentId: "dept_drinks", name: "Vino e Prosecco" },
    { id: "cat_cocktail", departmentId: "dept_drinks", name: "Cocktail" },
  ],
  products: [
    product("k_prosecco", "K Prosecco", "cat_wine"),
    product("k_vermentino", "K Vermentino", "cat_wine"),
    product("cocktail_martini", "Cocktail Martini", "cat_cocktail"),
  ],
};

afterEach(() => cleanup());

describe("order composer product search", () => {
  it("filters products immediately from the first typed character", () => {
    render(
      <TableOrderComposer
        open
        busy={false}
        catalog={catalog}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Cerca prodotto"), {
      target: { value: "K" },
    });

    expect(screen.getByText("K Prosecco")).toBeVisible();
    expect(screen.getByText("K Vermentino")).toBeVisible();
    expect(screen.queryByText("Cocktail Martini")).not.toBeInTheDocument();
  });
});
