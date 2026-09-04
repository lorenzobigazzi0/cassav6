import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  createPersistentRespRedisClient,
  createRedisVolatileStore,
  normalizeRedisConfig,
} from "../modules/redis/index.js";
import { createScopedReadsHandlers } from "../modules/scoped-reads/index.js";

function createFakeRedisClient() {
  const values = new Map();
  const ttls = new Map();
  return {
    values,
    ttls,
    async del(...keys) {
      let deleted = 0;
      keys.flat().forEach((key) => {
        if (values.delete(key)) deleted += 1;
      });
      return deleted;
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async incr(key) {
      const next = Number(values.get(key) ?? "0") + 1;
      values.set(key, String(next));
      return next;
    },
    async set(key, value, ttlMs) {
      values.set(key, value);
      ttls.set(key, ttlMs);
      return "OK";
    },
  };
}

function parseRespCommand(buffer) {
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0 || buffer[0] !== 42) return null;
  const count = Number(buffer.subarray(1, lineEnd).toString("utf8"));
  let offset = lineEnd + 2;
  const args = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[offset] !== 36) throw new Error("RESP request non valida");
    const lengthEnd = buffer.indexOf("\r\n", offset);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString("utf8"));
    const valueStart = lengthEnd + 2;
    const valueEnd = valueStart + length;
    if (buffer.length < valueEnd + 2) return null;
    args.push(buffer.subarray(valueStart, valueEnd).toString("utf8"));
    offset = valueEnd + 2;
  }
  return { args, offset };
}

async function createFakeRespServer(options = {}) {
  const values = new Map();
  const commandCounts = new Map();
  let connections = 0;
  let replies = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    connections += 1;
    const connectionId = connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (options.stallFirstConnection === true && connectionId === 1) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = parseRespCommand(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.offset);
        const [rawCommand, ...args] = parsed.args;
        const command = String(rawCommand ?? "").toUpperCase();
        commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);
        let response = "+OK\r\n";
        if (command === "SET") values.set(args[0], args[1]);
        if (command === "GET") {
          const value = values.get(args[0]);
          response = value === undefined ? "$-1\r\n" : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
        }
        if (command === "DEL") {
          let deleted = 0;
          args.forEach((key) => { if (values.delete(key)) deleted += 1; });
          response = `:${deleted}\r\n`;
        }
        if (command === "INCR") {
          const next = Number(values.get(args[0]) ?? "0") + 1;
          values.set(args[0], String(next));
          response = `:${next}\r\n`;
        }
        replies += 1;
        socket.write(response, () => {
          if (options.closeAfterReplies === replies) socket.destroy();
        });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    commandCounts,
    get connections() { return connections; },
    port: typeof address === "object" && address ? address.port : 0,
    async close() {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("redis volatile store normalizza flag e resta spento senza REDIS_ENABLED", async () => {
  const config = normalizeRedisConfig({
    REDIS_CACHE_ENABLED: "1",
    REDIS_PRESENCE_ENABLED: "1",
    REDIS_SESSIONS_ENABLED: "1",
  });
  const store = createRedisVolatileStore({ config, client: createFakeRedisClient() });

  assert.equal(store.enabled, false);
  assert.equal(store.cacheEnabled, false);
  assert.equal(config.persistentClient, false);
  assert.equal(config.persistentPoolSize, 4);
  assert.deepEqual(await store.getJson("cassav4:test"), {
    hit: false,
    skipped: "disabled",
  });
});

test("redis volatile store gestisce cache json, namespace, presence e sessione", async () => {
  const client = createFakeRedisClient();
  const counters = {};
  const store = createRedisVolatileStore({
    client,
    config: normalizeRedisConfig({
      REDIS_ENABLED: "1",
      REDIS_CACHE_ENABLED: "1",
      REDIS_PRESENCE_ENABLED: "1",
      REDIS_SESSIONS_ENABLED: "1",
      REDIS_KEY_PREFIX: "test",
      REDIS_CACHE_TTL_MS: "1234",
    }),
    nowIso: () => "2026-07-07T10:00:00.000Z",
    runtimeMetrics: {
      incrementCounter(name, amount = 1) {
        counters[name] = (counters[name] ?? 0) + amount;
      },
    },
  });

  const key = store.cacheKey("table", "table 1");
  await store.setJson(key, { id: "table_1" });
  assert.deepEqual(await store.getJson(key), { hit: true, value: { id: "table_1" } });
  assert.equal(client.ttls.get(key), 1234);

  await store.bumpCacheNamespace();
  assert.notEqual(store.cacheKey("table", "table 1"), key);

  await store.touchPresence({
    deviceUuid: "device-1",
    userId: "u1",
    username: "mario",
    clientApp: "mobile-frontend",
    sessionId: "s1",
  });
  await store.storeSession({
    deviceUuid: "device-1",
    userId: "u1",
    username: "mario",
    clientApp: "mobile-frontend",
    sessionId: "s1",
  });

  assert.equal(client.values.has("test:device:device-1:presence"), true);
  assert.equal(client.values.has("test:device:device-1:session"), true);
  assert.equal(counters.redisCacheHits, 1);
  assert.equal(counters.redisCacheSets, 1);
  assert.equal(counters.redisPresenceTouches, 1);
  assert.equal(counters.redisSessionWrites, 1);
});

test("redis volatile store coalesce gli invalidamenti cache concorrenti", async () => {
  const client = createFakeRedisClient();
  const counters = {};
  let incrCalls = 0;
  let incrStarted;
  let releaseIncr;
  const incrStartedPromise = new Promise((resolve) => {
    incrStarted = resolve;
  });
  const releaseIncrPromise = new Promise((resolve) => {
    releaseIncr = resolve;
  });
  client.incr = async (key) => {
    incrCalls += 1;
    incrStarted();
    await releaseIncrPromise;
    const next = Number(client.values.get(key) ?? "0") + 1;
    client.values.set(key, String(next));
    return next;
  };
  const store = createRedisVolatileStore({
    client,
    config: normalizeRedisConfig({
      REDIS_ENABLED: "1",
      REDIS_CACHE_ENABLED: "1",
      REDIS_KEY_PREFIX: "test",
    }),
    runtimeMetrics: {
      incrementCounter(name, amount = 1) {
        counters[name] = (counters[name] ?? 0) + amount;
      },
    },
  });

  const initialKey = store.cacheKey("orders", "station-1");
  const first = store.bumpCacheNamespace();
  await incrStartedPromise;
  const second = store.bumpCacheNamespace();
  const third = store.bumpCacheNamespace();

  assert.equal(incrCalls, 1);
  assert.notEqual(store.cacheKey("orders", "station-1"), initialKey);
  releaseIncr();
  await Promise.all([first, second, third]);

  assert.equal(incrCalls, 1);
  assert.equal(counters.redisCacheInvalidations, 3);
  assert.equal(counters.redisCacheInvalidationCoalesced, 2);
});

test("[BE][P4] cache auth Redis separa token sullo stesso device e invalida in batch", async () => {
  const client = createFakeRedisClient();
  const store = createRedisVolatileStore({
    client,
    config: normalizeRedisConfig({
      REDIS_ENABLED: "1",
      REDIS_SESSIONS_ENABLED: "1",
      REDIS_KEY_PREFIX: "test",
    }),
  });
  const first = {
    id: "session-1",
    userId: "user-1",
    deviceUuid: "device-1",
    tokenHash: "hash-1",
    clientApp: "mobile-frontend",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const second = {
    ...first,
    id: "session-2",
    sessionId: "session-2",
    tokenHash: "hash-2",
    clientApp: "postazione-frontend",
  };

  assert.equal(await store.storeAuthSession(first), true);
  assert.equal(await store.storeAuthSession(second), true);
  assert.notEqual(store.authSessionKey(first), store.authSessionKey(second));
  assert.equal((await store.getAuthSession(first)).value.id, "session-1");
  assert.equal((await store.getAuthSession(second)).value.id, "session-2");

  assert.equal(await store.deleteAuthSessions([first, second]), true);
  assert.deepEqual(await store.getAuthSession(first), { hit: false, skipped: "miss" });
  assert.deepEqual(await store.getAuthSession(second), { hit: false, skipped: "miss" });
  assert.equal(await store.deleteAuthSessions([first]), true, "DEL 0 e comunque una invalidazione riuscita");
});

test("[BE][P4] client RESP persistente riusa il pool e inizializza AUTH/SELECT una volta", async () => {
  const redis = await createFakeRespServer();
  const client = createPersistentRespRedisClient({
    url: `redis://user:password@127.0.0.1:${redis.port}/2`,
    poolSize: 2,
    connectTimeoutMs: 500,
    commandTimeoutMs: 1_000,
  });
  try {
    await client.set("shared", "value", 60_000);
    const values = await Promise.all(Array.from({ length: 24 }, () => client.get("shared")));
    assert.deepEqual(new Set(values), new Set(["value"]));
    const stats = client.getStats();
    assert.equal(stats.poolSize, 2);
    assert.equal(stats.connectionsOpened, 2);
    assert.equal(redis.connections, 2);
    assert.equal(redis.commandCounts.get("AUTH"), 2);
    assert.equal(redis.commandCounts.get("SELECT"), 2);
    assert.equal(redis.commandCounts.get("GET"), 24);
    assert.equal(stats.commands, 25);
  } finally {
    client.close();
    await redis.close();
  }
});

test("[BE][P4] client RESP persistente riconnette dopo chiusura remota", async () => {
  const redis = await createFakeRespServer({ closeAfterReplies: 1 });
  const client = createPersistentRespRedisClient({
    url: `redis://127.0.0.1:${redis.port}/0`,
    poolSize: 1,
    connectTimeoutMs: 500,
    commandTimeoutMs: 1_000,
  });
  try {
    assert.equal(await client.set("reconnect", "ok", 60_000), "OK");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await client.get("reconnect"), "ok");
    assert.equal(client.getStats().connectionsOpened, 2);
    assert.equal(client.getStats().reconnects, 1);
    assert.equal(redis.connections, 2);
  } finally {
    client.close();
    await redis.close();
  }
});

test("[BE][P4] timeout pipeline rompe la socket e riallinea il comando seguente", async () => {
  const redis = await createFakeRespServer({ stallFirstConnection: true });
  const client = createPersistentRespRedisClient({
    url: `redis://127.0.0.1:${redis.port}/0`,
    poolSize: 1,
    connectTimeoutMs: 500,
    commandTimeoutMs: 50,
  });
  try {
    const stalled = await Promise.allSettled([
      client.get("first"),
      client.get("second"),
      client.get("third"),
    ]);
    assert.equal(stalled.every((result) => result.status === "rejected"), true);
    assert.equal(await client.set("after-timeout", "aligned", 60_000), "OK");
    assert.equal(await client.get("after-timeout"), "aligned");
    assert.equal(client.getStats().connectionsOpened, 2);
    assert.equal(client.getStats().reconnects, 1);
  } finally {
    client.close();
    await redis.close();
  }
});

test("scoped reads usa Redis cache hit senza full read fallback", async () => {
  let readDbCalls = 0;
  const sent = [];
  const table = { id: "table_1", roomId: "room_1", number: 1 };
  const redisVolatileStore = {
    cacheEnabled: true,
    cacheKey: (kind, id) => `cache:${kind}:${id}`,
    async getJson(key) {
      assert.equal(key, "cache:table:table_1");
      return { hit: true, value: table };
    },
    async setJson() {
      throw new Error("setJson non deve essere chiamato su cache hit");
    },
  };
  const handlers = createScopedReadsHandlers({
    HttpError: class HttpError extends Error {},
    buildLayoutSnapshot: () => ({ tables: [] }),
    readDb: async () => {
      readDbCalls += 1;
      return {};
    },
    redisVolatileStore,
    sendJson: (_res, status, body) => sent.push({ status, body }),
  });

  await handlers.handleScopedTable({ params: { tableId: "table_1" } }, {}, new URL("http://local/api/tables/table_1"));

  assert.equal(readDbCalls, 0);
  assert.deepEqual(sent, [
    {
      status: 200,
      body: {
        ok: true,
        table,
        meta: {
          scopedRead: true,
          source: "redis",
          fullStateFallbackUsed: false,
          redisCacheHit: true,
        },
      },
    },
  ]);
});
