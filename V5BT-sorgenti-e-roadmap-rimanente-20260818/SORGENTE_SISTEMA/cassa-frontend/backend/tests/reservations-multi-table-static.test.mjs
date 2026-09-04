import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readSource = (relativePath) => readFileSync(resolve(repoRoot, relativePath), "utf8");

test("reservations keep multi-table ids in backend contract", () => {
  const server = readSource("server.js");
  const handlers = readSource("modules/reservations/reservations.handlers.js");
  const domain = readSource("modules/reservations/reservations.domain.js");

  assert.match(domain, /function normalizePosReservationTableIds/);
  assert.match(domain, /function posReservationIncludesTable/);
  assert.match(server, /posReservationIncludesTable\(reservation, tableId\)/);
  assert.match(handlers, /normalized\.assignedTableIds\.forEach/);
  assert.match(handlers, /assignedTableIds: normalized\.assignedTableIds/);
});

test("reservation activation creates table groups during layout refresh", () => {
  const server = readSource("server.js");

  assert.match(server, /function activateDuePosReservationsOnLayout/);
  assert.match(server, /function buildPosReservationTableGroup/);
  assert.match(server, /POS_RESERVATION_BLOCK_WINDOW_MS = 30 \* 60_000/);
  assert.match(server, /activateDuePosReservationsOnLayout\(db, db\.posSettings, nowMs\)/);
  assert.match(server, /clearIntegrationHotResponseCaches\(\)/);
  assert.match(server, /reservations_layout_activated/);
});

test("reservation table groups are split when the activated reservation is released", () => {
  const server = readSource("server.js");
  // Il motivo di rilascio viaggia con il handler del cambio sala, uscito da
  // server.js con MIG-031: l'invariante e lo stesso, cambia il file.
  const roomChange = readSource("modules/pos-rooms/room-change.handlers.js");

  assert.match(server, /function releaseActivatedPosReservationTableGroup/);
  assert.match(server, /isPosReservationReleased/);
  assert.match(server, /releasedAt: nowMs/);
  assert.match(server, /reservation\.table_group_released/);
  assert.match(roomChange, /reservation_table_group_released/);
});
