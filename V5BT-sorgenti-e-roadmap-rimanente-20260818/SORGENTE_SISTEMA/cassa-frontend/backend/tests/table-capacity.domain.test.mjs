import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TABLE_COVERS,
  normalizeTableCovers,
} from "../modules/tables/table-capacity.domain.js";

test("table capacity mantiene 100 come limite massimo", () => {
  assert.equal(normalizeTableCovers(100), MAX_TABLE_COVERS);
  assert.equal(normalizeTableCovers(101), MAX_TABLE_COVERS);
  assert.equal(normalizeTableCovers(999), MAX_TABLE_COVERS);
});

test("table capacity distingue tavolo libero e coperti obbligatori", () => {
  assert.equal(normalizeTableCovers(0), 0);
  assert.equal(normalizeTableCovers(0, { minimum: 1, fallback: 2 }), 1);
  assert.equal(normalizeTableCovers("non valido", { minimum: 1, fallback: 2 }), 2);
});
