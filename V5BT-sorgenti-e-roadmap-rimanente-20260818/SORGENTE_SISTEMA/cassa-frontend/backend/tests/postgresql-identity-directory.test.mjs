import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import {
  createPostgresqlIdentityDirectoryRepository,
  POSTGRESQL_IDENTITY_DIRECTORY_REPOSITORY_CONTRACT,
} from "../db/postgresql/index.js";

function harness(results = []) {
  const queue = [...results];
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return queue.shift() ?? { rows: [], rowCount: 0 };
    },
  };
  const runtime = {
    async withConnection(_label, callback) {
      return callback(client);
    },
    async withTransaction(label, callback, options) {
      assert.equal(label, "identity-directory:replace");
      assert.deepEqual(options, { isolationLevel: "SERIALIZABLE", maxAttempts: 3 });
      return callback(client);
    },
  };
  return { client, queries, runtime };
}

test("MIG-040 esporta il repository directory con replace transazionale", () => {
  assert.equal(POSTGRESQL_IDENTITY_DIRECTORY_REPOSITORY_CONTRACT.domain, "identity.directory");
  assert.deepEqual(POSTGRESQL_IDENTITY_DIRECTORY_REPOSITORY_CONTRACT.methods, [
    { name: "listDirectory", kind: "read", transaction: "none" },
    { name: "replaceDirectory", kind: "write", transaction: "supported" },
  ]);
});

test("replaceDirectory normalizza e scrive utenti, gruppi e permessi nella stessa transazione", async () => {
  const ctx = harness();
  const repository = createPostgresqlIdentityDirectoryRepository({ runtime: ctx.runtime });
  const result = await repository.replaceDirectory({
    groups: [{ id: "g-cassa", name: "Cassa", permissions: ["take_payment"] }],
    users: [{
      id: "u-admin",
      username: "admin",
      fullName: "Admin",
      role: "admin",
      roleLabel: "Amministratore",
      pin: "1234",
      pinHash: "scrypt$hash",
      permissions: ["manage_users", "manage_users"],
      groupIds: ["g-cassa"],
    }],
  });

  assert.equal(result.users.length, 1);
  assert.deepEqual(result.users[0].permissions, ["manage_users"]);
  assert.equal(Object.hasOwn(result.users[0].payload, "pin"), false);
  assert.ok(ctx.queries.some(({ sql }) => /INSERT INTO identity\.users/i.test(sql)));
  assert.ok(ctx.queries.some(({ sql }) => /INSERT INTO identity\.user_groups/i.test(sql)));
  assert.ok(ctx.queries.some(({ sql }) => /INSERT INTO identity\.user_permissions/i.test(sql)));
  assert.ok(ctx.queries.some(({ sql }) => /INSERT INTO identity\.group_permissions/i.test(sql)));
  assert.ok(ctx.queries.some(({ sql }) => /INSERT INTO identity\.user_group_members/i.test(sql)));
  assert.equal(ctx.queries[0].sql, "DELETE FROM identity.user_group_members");
});

test("replaceDirectory rifiuta username duplicati e riferimenti a gruppi inesistenti prima di scrivere", async () => {
  const ctx = harness();
  const repository = createPostgresqlIdentityDirectoryRepository({ runtime: ctx.runtime });
  await assert.rejects(
    repository.replaceDirectory({ users: [
      { id: "u-1", username: "Mario", role: "operator" },
      { id: "u-2", username: "mario", role: "operator" },
    ] }),
    /Username duplicato/,
  );
  await assert.rejects(
    repository.replaceDirectory({ users: [
      { id: "u-1", username: "mario", role: "operator", groupIds: ["missing"] },
    ] }),
    /Gruppo utente inesistente/,
  );
  assert.equal(ctx.queries.length, 0);
});

test("listDirectory ricostruisce la forma legacy senza perdere il payload applicativo", async () => {
  const ctx = harness([
    { rows: [{
      id: "u-1", username: "mario", full_name: "Mario Rossi", role_id: "operator",
      role_label: "Operatore", pin_hash: "scrypt$hash", enabled: true, revision: "3",
      payload: { enabledRoomIds: ["room-1"], role: "stale" },
      created_at: "2026-09-10T10:00:00.000Z", updated_at: "2026-09-10T11:00:00.000Z",
    }] },
    { rows: [{ user_id: "u-1", permission_id: "print_orders" }] },
    { rows: [{ user_id: "u-1", group_id: "g-1" }] },
    { rows: [{
      id: "g-1", name: "Sala", enabled: true, payload: { workstationIds: ["ws-1"] },
      created_at: "2026-09-10T10:00:00.000Z", updated_at: "2026-09-10T11:00:00.000Z",
    }] },
    { rows: [{ group_id: "g-1", permission_id: "manage_tables" }] },
  ]);
  const repository = createPostgresqlIdentityDirectoryRepository({ runtime: ctx.runtime });
  const directory = await repository.listDirectory();
  assert.deepEqual(directory.users[0].enabledRoomIds, ["room-1"]);
  assert.equal(directory.users[0].role, "operator");
  assert.equal(directory.users[0].revision, 3);
  assert.deepEqual(directory.users[0].permissions, ["print_orders"]);
  assert.deepEqual(directory.users[0].groupIds, ["g-1"]);
  assert.deepEqual(directory.groups[0].workstationIds, ["ws-1"]);
  assert.deepEqual(directory.groups[0].permissions, ["manage_tables"]);
});

test("migration 010 separa directory e sessioni e applica least privilege", async () => {
  const sql = await fs.readFile(
    new URL("../db/postgresql/migrations/010_identity_directory.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS identity/i);
  assert.match(sql, /CREATE TABLE identity\.users/i);
  assert.match(sql, /CREATE TABLE identity\.user_groups/i);
  assert.match(sql, /CREATE TABLE identity\.user_permissions/i);
  assert.match(sql, /CREATE TABLE identity\.group_permissions/i);
  assert.doesNotMatch(sql, /CREATE TABLE identity\.sessions/i);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM PUBLIC/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO cassav6_runtime/i);
});
