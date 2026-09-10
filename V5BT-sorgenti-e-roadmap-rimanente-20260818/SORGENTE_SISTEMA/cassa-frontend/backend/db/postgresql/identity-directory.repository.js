import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

export const POSTGRESQL_IDENTITY_DIRECTORY_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "identity.directory",
  methods: [
    { name: "listDirectory", kind: "read", transaction: "none" },
    { name: "replaceDirectory", kind: "write", transaction: "supported" },
  ],
});

function invalid(message) {
  const error = new TypeError(message);
  error.code = "POSTGRES_IDENTITY_DIRECTORY_INVALID_INPUT";
  return error;
}

function text(value, field, maxLength = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw invalid(`${field} non valido.`);
  }
  return normalized;
}

function optionalText(value, maxLength = 500) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw invalid("Valore testuale opzionale non valido.");
  }
  return normalized;
}

function uniqueTexts(values, field) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.isArray(values) ? values : []) {
    const normalized = text(entry, field);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function enabled(value) {
  return value !== false && value !== 0 && String(value ?? "").trim().toLowerCase() !== "false";
}

function safePayload(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  for (const field of ["pin", "plainPin", "pinCode", "password", "passwordPlain"]) delete payload[field];
  try {
    JSON.stringify(payload);
  } catch {
    throw invalid("Payload identity non serializzabile.");
  }
  return payload;
}

function normalizeDirectory(input = {}) {
  const users = [];
  const groups = [];
  const userIds = new Set();
  const usernames = new Set();
  const groupIds = new Set();

  for (const [sortOrder, candidate] of (Array.isArray(input.users) ? input.users : []).entries()) {
    const id = text(candidate?.id, "user.id");
    const username = text(candidate?.username, "user.username");
    const normalizedUsername = username.toLocaleLowerCase("it-IT");
    if (userIds.has(id)) throw invalid(`ID utente duplicato: ${id}.`);
    if (usernames.has(normalizedUsername)) throw invalid(`Username duplicato: ${username}.`);
    userIds.add(id);
    usernames.add(normalizedUsername);
    users.push({
      id,
      username,
      fullName: optionalText(candidate?.fullName),
      roleId: text(candidate?.role || "operator", "user.role"),
      roleLabel: optionalText(candidate?.roleLabel),
      pinHash: optionalText(candidate?.pinHash, 1024),
      enabled: enabled(candidate?.active ?? candidate?.enabled),
      revision: Math.max(1, Math.trunc(Number(candidate?.revision) || 1)),
      sortOrder,
      permissions: uniqueTexts(candidate?.permissions, "user.permission"),
      groupIds: uniqueTexts(candidate?.groupIds, "user.groupId"),
      payload: safePayload(candidate),
      createdAt: optionalText(candidate?.createdAt),
      updatedAt: optionalText(candidate?.updatedAt),
    });
  }

  for (const [sortOrder, candidate] of (Array.isArray(input.groups) ? input.groups : []).entries()) {
    const id = text(candidate?.id, "group.id");
    if (groupIds.has(id)) throw invalid(`ID gruppo duplicato: ${id}.`);
    groupIds.add(id);
    groups.push({
      id,
      name: text(candidate?.name ?? candidate?.label, "group.name"),
      enabled: enabled(candidate?.enabled),
      sortOrder,
      permissions: uniqueTexts(candidate?.permissions, "group.permission"),
      payload: safePayload(candidate),
      createdAt: optionalText(candidate?.createdAt),
      updatedAt: optionalText(candidate?.updatedAt),
    });
  }

  for (const user of users) {
    const missing = user.groupIds.find((groupId) => !groupIds.has(groupId));
    if (missing) throw invalid(`Gruppo utente inesistente: ${missing}.`);
  }
  return { users, groups };
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function mapMany(rows, ownerField, valueField) {
  const result = new Map();
  for (const row of rows ?? []) {
    const owner = String(row[ownerField]);
    const values = result.get(owner) ?? [];
    values.push(String(row[valueField]));
    result.set(owner, values);
  }
  return result;
}

function requireRuntime(runtime) {
  if (typeof runtime?.withConnection !== "function" || typeof runtime?.withTransaction !== "function") {
    throw invalid("Runtime PostgreSQL non valido per identity directory.");
  }
  return runtime;
}

async function insertDirectory(client, directory) {
  const roles = new Map(directory.users.map((user) => [user.roleId, user.roleLabel ?? user.roleId]));
  const permissions = new Set([
    ...directory.users.flatMap((user) => user.permissions),
    ...directory.groups.flatMap((group) => group.permissions),
  ]);

  await client.query("DELETE FROM identity.user_group_members");
  await client.query("DELETE FROM identity.group_permissions");
  await client.query("DELETE FROM identity.user_permissions");

  for (const [id, label] of roles) {
    await client.query(
      `INSERT INTO identity.roles (id, name, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, label = EXCLUDED.label, updated_at = now()`,
      [id, id, label],
    );
  }
  for (const permission of permissions) {
    await client.query(
      `INSERT INTO identity.permissions (id, name) VALUES ($1, $1)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [permission],
    );
  }
  for (const group of directory.groups) {
    await client.query(
      `INSERT INTO identity.user_groups (id, name, enabled, sort_order, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), COALESCE($7::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled,
         sort_order = EXCLUDED.sort_order, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [group.id, group.name, group.enabled, group.sortOrder, group.payload, group.createdAt, group.updatedAt],
    );
    for (const permission of group.permissions) {
      await client.query(
        "INSERT INTO identity.group_permissions (group_id, permission_id) VALUES ($1, $2)",
        [group.id, permission],
      );
    }
  }
  for (const user of directory.users) {
    await client.query(
      `INSERT INTO identity.users (
         id, username, full_name, role_id, role_label, pin_hash, enabled, revision,
         sort_order, payload, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,now()),COALESCE($12::timestamptz,now()))
       ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, full_name = EXCLUDED.full_name,
         role_id = EXCLUDED.role_id, role_label = EXCLUDED.role_label, pin_hash = EXCLUDED.pin_hash,
         enabled = EXCLUDED.enabled, revision = identity.users.revision + 1,
         sort_order = EXCLUDED.sort_order, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        user.id, user.username, user.fullName, user.roleId, user.roleLabel, user.pinHash,
        user.enabled, user.revision, user.sortOrder, user.payload, user.createdAt, user.updatedAt,
      ],
    );
    for (const permission of user.permissions) {
      await client.query(
        "INSERT INTO identity.user_permissions (user_id, permission_id) VALUES ($1, $2)",
        [user.id, permission],
      );
    }
    for (const groupId of user.groupIds) {
      await client.query(
        "INSERT INTO identity.user_group_members (group_id, user_id) VALUES ($1, $2)",
        [groupId, user.id],
      );
    }
  }

  await client.query("DELETE FROM identity.users WHERE id <> ALL($1::text[])", [directory.users.map(({ id }) => id)]);
  await client.query("DELETE FROM identity.user_groups WHERE id <> ALL($1::text[])", [directory.groups.map(({ id }) => id)]);
  await client.query("DELETE FROM identity.roles WHERE id <> ALL($1::text[])", [[...roles.keys()]]);
  await client.query("DELETE FROM identity.permissions WHERE id <> ALL($1::text[])", [[...permissions]]);
}

export function createPostgresqlIdentityDirectoryRepository(options = {}) {
  const runtime = requireRuntime(options.runtime);
  const implementation = {
    async listDirectory() {
      return runtime.withConnection("identity-directory:list", async (client) => {
        const [usersResult, userPermissionsResult, membershipsResult, groupsResult, groupPermissionsResult] = await Promise.all([
          client.query("SELECT * FROM identity.users ORDER BY sort_order ASC, id ASC"),
          client.query("SELECT user_id, permission_id FROM identity.user_permissions ORDER BY user_id, permission_id"),
          client.query("SELECT user_id, group_id FROM identity.user_group_members ORDER BY user_id, group_id"),
          client.query("SELECT * FROM identity.user_groups ORDER BY sort_order ASC, id ASC"),
          client.query("SELECT group_id, permission_id FROM identity.group_permissions ORDER BY group_id, permission_id"),
        ]);
        const userPermissions = mapMany(userPermissionsResult.rows, "user_id", "permission_id");
        const memberships = mapMany(membershipsResult.rows, "user_id", "group_id");
        const groupPermissions = mapMany(groupPermissionsResult.rows, "group_id", "permission_id");
        const users = (usersResult.rows ?? []).map((row) => ({
          ...(row.payload && typeof row.payload === "object" ? row.payload : {}),
          id: row.id,
          username: row.username,
          fullName: row.full_name,
          role: row.role_id,
          roleLabel: row.role_label,
          pinHash: row.pin_hash,
          active: row.enabled === true,
          revision: Number(row.revision),
          permissions: userPermissions.get(String(row.id)) ?? [],
          groupIds: memberships.get(String(row.id)) ?? [],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        }));
        const groups = (groupsResult.rows ?? []).map((row) => ({
          ...(row.payload && typeof row.payload === "object" ? row.payload : {}),
          id: row.id,
          name: row.name,
          enabled: row.enabled === true,
          permissions: groupPermissions.get(String(row.id)) ?? [],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        }));
        return { users, groups };
      });
    },

    async replaceDirectory(input = {}, options = {}) {
      const directory = normalizeDirectory(input);
      if (options.client) {
        await insertDirectory(options.client, directory);
        return directory;
      }
      return runtime.withTransaction("identity-directory:replace", async (client) => {
        await insertDirectory(client, directory);
        return directory;
      }, { isolationLevel: "SERIALIZABLE", maxAttempts: 3 });
    },
  };
  return assertRepositoryImplementation(POSTGRESQL_IDENTITY_DIRECTORY_REPOSITORY_CONTRACT, implementation);
}

