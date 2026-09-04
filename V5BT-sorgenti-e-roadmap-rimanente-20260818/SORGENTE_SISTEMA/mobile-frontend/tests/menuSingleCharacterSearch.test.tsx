import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuWorkspace } from "../src/pages/home/menu/MenuWorkspace";

const queryResult = vi.hoisted(() => {
  const product = (id: string, name: string, categoryId: string) => ({
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

  return {
    data: {
      version: 1,
      catalog: {
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
      },
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryResult,
}));

vi.mock("../src/store/authStore", () => ({
  useAuthStore: () => ({
    token: "token",
    userId: "user",
    deviceUuid: "device",
    roomId: "room",
  }),
}));

vi.mock("../src/app/runtime/realtimeTransportStatus", () => ({
  useRealtimeTransportStatus: () => ({ connected: true }),
}));

vi.mock("../src/pages/home/menu/hooks/useTimedPricingRefresh", () => ({
  useTimedPricingRefresh: () => undefined,
}));

vi.mock("../src/pages/home/menu/hooks/useMenuEdgeBack", () => ({
  useMenuEdgeBack: () => ({}),
}));

afterEach(() => cleanup());

describe("menu product search", () => {
  it("shows matching products directly from the first typed character", () => {
    render(<MenuWorkspace />);

    fireEvent.change(screen.getByPlaceholderText("Cerca prodotti..."), {
      target: { value: "K" },
    });

    expect(screen.getByText("K Prosecco")).toBeVisible();
    expect(screen.getByText("K Vermentino")).toBeVisible();
    expect(screen.queryByText("Cocktail Martini")).not.toBeInTheDocument();
    expect(screen.getByText("Risultati ricerca")).toBeVisible();
  });
});
