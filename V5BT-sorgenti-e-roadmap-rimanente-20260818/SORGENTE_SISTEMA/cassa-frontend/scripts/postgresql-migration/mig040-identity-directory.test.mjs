import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalIdentityDirectory,
  reconcileIdentityDirectories,
} from "./mig040-identity-directory.mjs";

test("riconciliazione MIG-040 ignora ordine ma confronta identita e autorizzazioni", () => {
  const source = {
    users: [{
      id: "u-1", username: "mario", role: "operator", active: true,
      permissions: ["print", "pay"], groupIds: ["g-1"], pinHash: "hash",
    }],
    groups: [{ id: "g-1", name: "Sala", permissions: ["tables", "orders"] }],
  };
  const equivalent = {
    users: [{
      ...source.users[0], permissions: ["pay", "print"], groupIds: ["g-1", "g-1"],
    }],
    groups: [{ ...source.groups[0], permissions: ["orders", "tables"] }],
  };
  assert.equal(reconcileIdentityDirectories(source, equivalent).ok, true);
  assert.equal(reconcileIdentityDirectories(source, {
    ...equivalent,
    users: [{ ...equivalent.users[0], permissions: ["print"] }],
  }).ok, false);
});

test("proiezione canonica non include attributi applicativi estranei al gate identity", () => {
  const projected = canonicalIdentityDirectory({
    users: [{ id: "u-1", username: "mario", role: "operator", fiscalPolicy: "x" }],
    groups: [],
  });
  assert.equal(Object.hasOwn(projected.users[0], "fiscalPolicy"), false);
});

