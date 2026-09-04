import { describe, expect, it } from "vitest";

import { MAX_TABLE_COVERS, normalizeTableCovers } from "./capacity";

describe("table capacity", () => {
  it("accetta il limite di 100 coperti", () => {
    expect(normalizeTableCovers(100)).toBe(MAX_TABLE_COVERS);
  });

  it("normalizza qualsiasi valore superiore a 100", () => {
    expect(normalizeTableCovers(101)).toBe(MAX_TABLE_COVERS);
    expect(normalizeTableCovers(999)).toBe(MAX_TABLE_COVERS);
  });

  it("consente zero solo ai tavoli liberi", () => {
    expect(normalizeTableCovers(0)).toBe(1);
    expect(normalizeTableCovers(0, { minimum: 0, fallback: 0 })).toBe(0);
  });
});
