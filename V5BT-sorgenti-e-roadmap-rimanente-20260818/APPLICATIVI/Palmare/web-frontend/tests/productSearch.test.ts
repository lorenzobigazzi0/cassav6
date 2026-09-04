import { describe, expect, it } from "vitest";
import { textPartsMatchProductSearch } from "../src/utils/productSearch";

describe("product search matching", () => {
  const products = ["K Prosecco", "K Vermentino", "K Chardonnay", "Cocktail Martini"];

  const matches = (query: string) =>
    products.filter((name) => textPartsMatchProductSearch([name], query));

  it("filtra gli articoli K gia dalla prima lettera e anche con spazio finale", () => {
    expect(matches("k")).toEqual(["K Prosecco", "K Vermentino", "K Chardonnay"]);
    expect(matches("k ")).toEqual(["K Prosecco", "K Vermentino", "K Chardonnay"]);
  });

  it("supporta prefissi a parole senza aspettare la parola completa", () => {
    expect(matches("k p")).toEqual(["K Prosecco"]);
    expect(matches("k v")).toEqual(["K Vermentino"]);
    expect(matches("k c")).toEqual(["K Chardonnay"]);
  });
});
