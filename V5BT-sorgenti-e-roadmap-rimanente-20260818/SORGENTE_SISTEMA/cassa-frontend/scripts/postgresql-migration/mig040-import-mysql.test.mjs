import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdentityImportPlan,
  reconcileIdentityImport,
} from "./mig040-import-mysql.mjs";

const admin = {
  id: "u-admin",
  username: "admin",
  role: "admin",
  pinHash: `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`,
  permissions: ["manage_users"],
};

test("il piano MIG-040 ricostruisce l'ordine MariaDB e richiede un amministratore", () => {
  const plan = buildIdentityImportPlan([
    { domain: "users", record_id: "u-2", app_state_position: 1, raw_json: JSON.stringify({ ...admin, id: "u-2" }) },
    { domain: "users", record_id: "u-1", app_state_position: 0, raw_json: JSON.stringify({ id: "u-1", username: "op", role: "operator" }) },
    { domain: "userGroups", record_id: "g-1", app_state_position: 0, raw_json: JSON.stringify({ id: "g-1", name: "Sala" }) },
  ]);
  assert.deepEqual(plan.users.map(({ id }) => id), ["u-1", "u-2"]);
  assert.equal(plan.adminCount, 1);
  assert.throws(() => buildIdentityImportPlan([
    { domain: "users", record_id: "u-1", app_state_position: 0, raw_json: JSON.stringify({ id: "u-1", username: "op", role: "operator" }) },
  ]), /nessun amministratore/);
});

test("la riconciliazione confronta i row hash e rileva una variazione di permesso", () => {
  const source = { users: [admin], userGroups: [] };
  assert.equal(reconcileIdentityImport(source, structuredClone(source)).ok, true);
  assert.equal(reconcileIdentityImport(source, {
    users: [{ ...admin, permissions: [] }],
    userGroups: [],
  }).ok, false);
});

