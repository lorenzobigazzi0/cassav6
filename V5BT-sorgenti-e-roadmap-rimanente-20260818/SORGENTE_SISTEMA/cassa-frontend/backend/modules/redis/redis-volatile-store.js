import net from "node:net";
import tls from "node:tls";

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parsePositiveMs(value, fallback) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function parsePositiveInt(value, fallback, max = 64) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, max) : fallback;
}

function normalizeKeyPart(value, fallback = "unknown") {
  return String(value ?? fallback)
    .trim()
    .replace(/[^\w:.-]+/g, "_")
    .slice(0, 180) || fallback;
}

function encodeRespCommand(args) {
  return `*${args.length}\r\n${args
    .map((arg) => {
      const value = Buffer.from(String(arg ?? ""));
      return `$${value.length}\r\n${value.toString("utf8")}\r\n`;
    })
    .join("")}`;
}

function findLineEnd(buffer, offset) {
  for (let index = offset; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
  }
  return -1;
}

function parseRespReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]);
  const lineEnd = findLineEnd(buffer, offset + 1);
  if (lineEnd < 0) return null;
  const header = buffer.subarray(offset + 1, lineEnd).toString("utf8");
  const nextOffset = lineEnd + 2;
  if (prefix === "+") return { value: header, offset: nextOffset };
  if (prefix === "-") throw new Error(header || "Redis error");
  if (prefix === ":") return { value: Number(header), offset: nextOffset };
  if (prefix === "$") {
    const length = Number(header);
    if (length === -1) return { value: null, offset: nextOffset };
    if (!Number.isFinite(length) || length < 0) throw new Error("Risposta Redis bulk non valida.");
    const end = nextOffset + length;
    if (buffer.length < end + 2) return null;
    return {
      value: buffer.subarray(nextOffset, end).toString("utf8"),
      offset: end + 2,
    };
  }
  if (prefix === "*") {
    const count = Number(header);
    if (count === -1) return { value: null, offset: nextOffset };
    if (!Number.isFinite(count) || count < 0) throw new Error("Risposta Redis array non valida.");
    const values = [];
    let currentOffset = nextOffset;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRespReply(buffer, currentOffset);
      if (!parsed) return null;
      values.push(parsed.value);
      currentOffset = parsed.offset;
    }
    return { value: values, offset: currentOffset };
  }
  throw new Error(`Risposta Redis non supportata: ${prefix}`);
}

function parseRedisUrl(redisUrl) {
  const parsed = new URL(redisUrl || "redis://127.0.0.1:6379/0");
  const secure = parsed.protocol === "rediss:";
  const dbText = parsed.pathname.replace(/^\//, "");
  return {
    db: dbText ? Math.max(0, Math.trunc(Number(dbText)) || 0) : 0,
    host: parsed.hostname || "127.0.0.1",
    password: decodeURIComponent(parsed.password || ""),
    port: Number(parsed.port) || (secure ? 6380 : 6379),
    secure,
    username: decodeURIComponent(parsed.username || ""),
  };
}

export function normalizeRedisConfig(env = {}) {
  const enabled = parseBool(env.REDIS_ENABLED);
  return {
    enabled,
    cacheEnabled: enabled && parseBool(env.REDIS_CACHE_ENABLED),
    sessionsEnabled: enabled && parseBool(env.REDIS_SESSIONS_ENABLED),
    presenceEnabled: enabled && parseBool(env.REDIS_PRESENCE_ENABLED),
    persistentClient: enabled && parseBool(env.REDIS_PERSISTENT_CLIENT),
    persistentPoolSize: parsePositiveInt(env.REDIS_PERSISTENT_POOL_SIZE, 4, 64),
    url: String(env.REDIS_URL || "redis://127.0.0.1:6379/0"),
    keyPrefix: normalizeKeyPart(env.REDIS_KEY_PREFIX || "cassav4", "cassav4"),
    cacheTtlMs: parsePositiveMs(env.REDIS_CACHE_TTL_MS, 4_000),
    sessionTtlMs: parsePositiveMs(env.REDIS_SESSION_TTL_MS, 10 * 60 * 1000),
    presenceTtlMs: parsePositiveMs(env.REDIS_PRESENCE_TTL_MS, 30_000),
    connectTimeoutMs: parsePositiveMs(env.REDIS_CONNECT_TIMEOUT_MS, 250),
    commandTimeoutMs: parsePositiveMs(env.REDIS_COMMAND_TIMEOUT_MS, 250),
  };
}

export function createRespRedisClient(options = {}) {
  const {
    commandTimeoutMs = 250,
    connectTimeoutMs = 250,
    logger = console,
    netModule = net,
    tlsModule = tls,
    url = "redis://127.0.0.1:6379/0",
  } = options;
  const config = parseRedisUrl(url);

  async function runCommand(args) {
    const commandList = [];
    if (config.password) {
      commandList.push(
        config.username
          ? ["AUTH", config.username, config.password]
          : ["AUTH", config.password],
      );
    }
    if (config.db > 0) commandList.push(["SELECT", String(config.db)]);
    commandList.push(args);
    const payload = commandList.map(encodeRespCommand).join("");

    return await new Promise((resolve, reject) => {
      let settled = false;
      let buffer = Buffer.alloc(0);
      const socket = config.secure
        ? tlsModule.connect({ host: config.host, port: config.port })
        : netModule.connect({ host: config.host, port: config.port });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("Redis command timeout"));
      }, Math.max(connectTimeoutMs, commandTimeoutMs));
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      }
      socket.setTimeout(connectTimeoutMs, () => finish(new Error("Redis connect timeout")));
      socket.on("connect", () => {
        socket.setTimeout(commandTimeoutMs, () => finish(new Error("Redis command timeout")));
        socket.write(payload);
      });
      socket.on("error", (error) => finish(error));
      socket.on("data", (chunk) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          let offset = 0;
          let reply = null;
          for (let index = 0; index < commandList.length; index += 1) {
            reply = parseRespReply(buffer, offset);
            if (!reply) return;
            offset = reply.offset;
          }
          finish(null, reply?.value);
        } catch (error) {
          finish(error);
        }
      });
      socket.on("close", () => {
        if (!settled && buffer.length === 0) {
          logger.debug?.("[redis] connessione chiusa senza risposta");
        }
      });
    });
  }

  return {
    async del(...keys) {
      const normalizedKeys = keys.flat().map((key) => String(key ?? "")).filter(Boolean);
      if (normalizedKeys.length === 0) return 0;
      return await runCommand(["DEL", ...normalizedKeys]);
    },
    async get(key) {
      return await runCommand(["GET", key]);
    },
    async incr(key) {
      return await runCommand(["INCR", key]);
    },
    async set(key, value, ttlMs) {
      const ttl = Math.max(1, Math.trunc(Number(ttlMs) || 1));
      return await runCommand(["SET", key, value, "PX", String(ttl)]);
    },
  };
}

export function createPersistentRespRedisClient(options = {}) {
  const {
    commandTimeoutMs = 250,
    connectTimeoutMs = 250,
    netModule = net,
    poolSize = 4,
    tlsModule = tls,
    url = "redis://127.0.0.1:6379/0",
  } = options;
  const config = parseRedisUrl(url);
  const size = parsePositiveInt(poolSize, 4, 64);
  let closed = false;
  let roundRobin = 0;
  let commands = 0;
  let connectionsOpened = 0;
  let reconnects = 0;

  function createLane() {
    let socket = null;
    let connectPromise = null;
    let initializePromise = null;
    let initialized = false;
    let buffer = Buffer.alloc(0);
    let pending = [];
    let depth = 0;
    let hasConnected = false;

    function breakConnection(error, target = socket) {
      if (target && socket && target !== socket) return;
      const current = socket;
      socket = null;
      connectPromise = null;
      initializePromise = null;
      initialized = false;
      buffer = Buffer.alloc(0);
      const pendingError = error ?? new Error("Connessione Redis chiusa.");
      const rejected = pending;
      pending = [];
      rejected.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.reject(pendingError);
      });
      if (current && !current.destroyed) current.destroy();
    }

    function onData(target, chunk) {
      if (target !== socket) return;
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (pending.length > 0) {
          const reply = parseRespReply(buffer, 0);
          if (!reply) return;
          const currentPending = pending.shift();
          clearTimeout(currentPending.timer);
          buffer = buffer.subarray(reply.offset);
          currentPending.resolve(reply.value);
        }
      } catch (error) {
        breakConnection(error, target);
      }
    }

    async function ensureSocket() {
      if (closed) throw new Error("Client Redis chiuso.");
      if (connectPromise) return await connectPromise;
      if (socket && !socket.destroyed) return socket;
      connectPromise = new Promise((resolve, reject) => {
        const target = config.secure
          ? tlsModule.connect({ host: config.host, port: config.port })
          : netModule.connect({ host: config.host, port: config.port });
        socket = target;
        buffer = Buffer.alloc(0);
        pending = [];
        initializePromise = null;
        initialized = false;
        let settled = false;
        const timer = setTimeout(() => finish(new Error("Redis connect timeout")), connectTimeoutMs);
        const readyEvent = config.secure ? "secureConnect" : "connect";

        function cleanupConnectListeners() {
          clearTimeout(timer);
          target.removeListener(readyEvent, onReady);
          target.removeListener("error", onConnectError);
          target.removeListener("close", onConnectClose);
        }
        function finish(error) {
          if (settled) return;
          settled = true;
          cleanupConnectListeners();
          if (error) {
            if (target === socket) socket = null;
            if (!target.destroyed) target.destroy();
            reject(error);
            return;
          }
          connectionsOpened += 1;
          if (hasConnected) reconnects += 1;
          hasConnected = true;
          target.setNoDelay?.(true);
          target.unref?.();
          target.on("data", (chunk) => onData(target, chunk));
          target.on("error", (socketError) => breakConnection(socketError, target));
          target.on("close", () => breakConnection(new Error("Connessione Redis chiusa."), target));
          resolve(target);
        }
        function onReady() {
          finish(null);
        }
        function onConnectError(error) {
          finish(error);
        }
        function onConnectClose() {
          finish(new Error("Connessione Redis chiusa durante il connect."));
        }

        target.once(readyEvent, onReady);
        target.once("error", onConnectError);
        target.once("close", onConnectClose);
      }).finally(() => {
        connectPromise = null;
      });
      return await connectPromise;
    }

    async function sendRaw(target, args, queuedAt) {
      if (target !== socket || target.destroyed) throw new Error("Connessione Redis non disponibile.");
      const remainingMs = Math.max(1, commandTimeoutMs - (Date.now() - queuedAt));
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => breakConnection(new Error("Redis command timeout"), target), remainingMs);
        pending.push({ reject, resolve, timer });
        target.write(encodeRespCommand(args), (error) => {
          if (error) breakConnection(error, target);
        });
      });
    }

    async function ensureInitialized(target, queuedAt) {
      if (initialized) return;
      if (initializePromise) return await initializePromise;
      initializePromise = (async () => {
        if (config.password) {
          await sendRaw(target, config.username ? ["AUTH", config.username, config.password] : ["AUTH", config.password], queuedAt);
        }
        if (config.db > 0) await sendRaw(target, ["SELECT", String(config.db)], queuedAt);
        if (target !== socket || target.destroyed) throw new Error("Connessione Redis persa durante init.");
        initialized = true;
      })().finally(() => {
        initializePromise = null;
      });
      return await initializePromise;
    }

    async function send(args, queuedAt) {
      if (Date.now() - queuedAt >= commandTimeoutMs) throw new Error("Redis command queue timeout");
      const target = await ensureSocket();
      await ensureInitialized(target, queuedAt);
      return await sendRaw(target, args, queuedAt);
    }

    function enqueue(args) {
      const queuedAt = Date.now();
      depth += 1;
      const task = send(args, queuedAt);
      return task.then(
        (value) => {
          depth -= 1;
          return value;
        },
        (error) => {
          depth -= 1;
          throw error;
        },
      );
    }

    return {
      close() {
        breakConnection(new Error("Client Redis chiuso."));
      },
      enqueue,
      get depth() {
        return depth;
      },
      get connected() {
        return Boolean(socket && !socket.destroyed);
      },
    };
  }

  const lanes = Array.from({ length: size }, createLane);

  async function runCommand(args) {
    if (closed) throw new Error("Client Redis chiuso.");
    commands += 1;
    let selected = lanes[roundRobin % lanes.length];
    roundRobin += 1;
    for (const lane of lanes) {
      if (lane.depth < selected.depth) selected = lane;
    }
    return await selected.enqueue(args);
  }

  return {
    close() {
      closed = true;
      lanes.forEach((lane) => lane.close());
    },
    async del(...keys) {
      const normalizedKeys = keys.flat().map((key) => String(key ?? "")).filter(Boolean);
      if (normalizedKeys.length === 0) return 0;
      return await runCommand(["DEL", ...normalizedKeys]);
    },
    async get(key) {
      return await runCommand(["GET", key]);
    },
    getStats() {
      return {
        closed,
        commands,
        connectionsOpened,
        openConnections: lanes.reduce((sum, lane) => sum + (lane.connected ? 1 : 0), 0),
        reconnects,
        poolSize: size,
        queued: lanes.reduce((sum, lane) => sum + lane.depth, 0),
      };
    },
    async incr(key) {
      return await runCommand(["INCR", key]);
    },
    async set(key, value, ttlMs) {
      const ttl = Math.max(1, Math.trunc(Number(ttlMs) || 1));
      return await runCommand(["SET", key, value, "PX", String(ttl)]);
    },
  };
}

export function createRedisVolatileStore(options = {}) {
  const config = options.config ?? normalizeRedisConfig(options.env ?? {});
  const logger = options.logger ?? console;
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const client =
    options.client ??
    (config.enabled
      ? (config.persistentClient ? createPersistentRespRedisClient : createRespRedisClient)({
          commandTimeoutMs: config.commandTimeoutMs,
          connectTimeoutMs: config.connectTimeoutMs,
          logger,
          poolSize: config.persistentPoolSize,
          url: config.url,
        })
      : null);
  let cacheVersion = 1;
  let cacheNamespaceBumpPromise = null;

  function metric(name, amount = 1) {
    runtimeMetrics?.incrementCounter?.(name, amount);
  }

  function recordClientStats() {
    const stats = client?.getStats?.();
    if (!stats) return;
    runtimeMetrics?.setGauge?.("redisClientPoolSize", stats.poolSize);
    runtimeMetrics?.setGauge?.("redisClientOpenConnections", stats.openConnections);
    runtimeMetrics?.setGauge?.("redisClientConnectionsOpened", stats.connectionsOpened);
    runtimeMetrics?.setGauge?.("redisClientReconnects", stats.reconnects);
    runtimeMetrics?.setGauge?.("redisClientQueued", stats.queued);
    runtimeMetrics?.setGauge?.("redisClientCommands", stats.commands);
  }

  function key(...parts) {
    return [config.keyPrefix, ...parts.map((part) => normalizeKeyPart(part))].join(":");
  }

  function cacheKey(kind, id) {
    return key("cache", `v${cacheVersion}`, kind, id);
  }

  function authSessionKey(input = {}) {
    const deviceUuid = normalizeKeyPart(input.deviceUuid, "");
    const tokenHash = normalizeKeyPart(input.tokenHash, "");
    if (!deviceUuid || !tokenHash) return "";
    return key("auth-session", deviceUuid, tokenHash);
  }

  function applyRedisCacheVersion(nextVersion) {
    const redisVersion = Number(nextVersion);
    if (Number.isFinite(redisVersion) && redisVersion > 0) {
      cacheVersion = Math.max(cacheVersion, redisVersion);
    }
    return cacheVersion;
  }

  async function safeRedis(label, action, fallback) {
    if (!client) return fallback;
    try {
      return await action();
    } catch (error) {
      metric("redisErrors");
      logger.warn?.(`[redis] ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    } finally {
      recordClientStats();
    }
  }

  async function getJson(keyName) {
    if (!config.cacheEnabled || !client) return { hit: false, skipped: "disabled" };
    const raw = await safeRedis("cache get", () => client.get(keyName), null);
    if (!raw) {
      metric("redisCacheMisses");
      return { hit: false, skipped: "miss" };
    }
    try {
      metric("redisCacheHits");
      return { hit: true, value: JSON.parse(raw) };
    } catch {
      metric("redisCacheMisses");
      return { hit: false, skipped: "invalid_json" };
    }
  }

  async function setJson(keyName, value, ttlMs = config.cacheTtlMs) {
    if (!config.cacheEnabled || !client) return false;
    const ok = await safeRedis(
      "cache set",
      () => client.set(keyName, JSON.stringify(value), ttlMs),
      null,
    );
    if (ok) metric("redisCacheSets");
    return Boolean(ok);
  }

  async function bumpCacheNamespace() {
    cacheVersion += 1;
    metric("redisCacheInvalidations");
    if (!config.cacheEnabled || !client) return cacheVersion;
    if (cacheNamespaceBumpPromise) {
      metric("redisCacheInvalidationCoalesced");
      return await cacheNamespaceBumpPromise;
    }
    cacheNamespaceBumpPromise = safeRedis(
      "cache namespace bump",
      () => client.incr(key("cache", "version")),
      null,
    )
      .then(applyRedisCacheVersion)
      .finally(() => {
        cacheNamespaceBumpPromise = null;
      });
    return await cacheNamespaceBumpPromise;
  }

  async function touchPresence(input = {}) {
    if (!config.presenceEnabled || !client) return false;
    const deviceUuid = normalizeKeyPart(input.deviceUuid, "");
    if (!deviceUuid) return false;
    const payload = {
      deviceUuid,
      userId: String(input.userId ?? "").trim(),
      username: String(input.username ?? "").trim(),
      clientApp: String(input.clientApp ?? "").trim(),
      sessionId: String(input.sessionId ?? "").trim(),
      roomId: String(input.roomId ?? "").trim(),
      stationName: String(input.stationName ?? "").trim(),
      lastSeenAt: input.lastSeenAt ?? nowIso(),
    };
    const ok = await safeRedis(
      "presence touch",
      () => client.set(key("device", deviceUuid, "presence"), JSON.stringify(payload), config.presenceTtlMs),
      null,
    );
    if (ok) metric("redisPresenceTouches");
    return Boolean(ok);
  }

  async function storeSession(input = {}) {
    if (!config.sessionsEnabled || !client) return false;
    const deviceUuid = normalizeKeyPart(input.deviceUuid, "");
    const sessionId = normalizeKeyPart(input.sessionId, "");
    if (!deviceUuid || !sessionId) return false;
    const payload = {
      deviceUuid,
      sessionId,
      userId: String(input.userId ?? "").trim(),
      username: String(input.username ?? "").trim(),
      clientApp: String(input.clientApp ?? "").trim(),
      roomId: String(input.roomId ?? "").trim(),
      stationName: String(input.stationName ?? "").trim(),
      expiresAt: input.expiresAt ?? null,
      lastSeenAt: input.lastSeenAt ?? nowIso(),
    };
    const ttlMs = Math.max(
      1,
      Math.min(
        config.sessionTtlMs,
        Number.isFinite(Date.parse(String(payload.expiresAt ?? "")))
          ? Date.parse(String(payload.expiresAt)) - Date.now()
          : config.sessionTtlMs,
      ),
    );
    const ok = await safeRedis(
      "session set",
      () => client.set(key("device", deviceUuid, "session"), JSON.stringify(payload), ttlMs),
      null,
    );
    if (ok) metric("redisSessionWrites");
    return Boolean(ok);
  }

  async function getAuthSession(input = {}) {
    if (!config.sessionsEnabled || !client) return { hit: false, skipped: "disabled" };
    const keyName = authSessionKey(input);
    if (!keyName) return { hit: false, skipped: "invalid_key" };
    const redisFailure = Symbol("redis_failure");
    const raw = await safeRedis("auth session get", () => client.get(keyName), redisFailure);
    if (raw === redisFailure) {
      metric("redisAuthSessionErrors");
      return { hit: false, skipped: "error" };
    }
    if (!raw) {
      metric("redisAuthSessionMisses");
      return { hit: false, skipped: "miss" };
    }
    try {
      const value = JSON.parse(raw);
      if (
        String(value?.deviceUuid ?? "").trim() !== String(input.deviceUuid ?? "").trim() ||
        String(value?.tokenHash ?? "").trim() !== String(input.tokenHash ?? "").trim()
      ) {
        metric("redisAuthSessionMisses");
        return { hit: false, skipped: "identity_mismatch" };
      }
      metric("redisAuthSessionHits");
      return { hit: true, value };
    } catch {
      metric("redisAuthSessionMisses");
      return { hit: false, skipped: "invalid_json" };
    }
  }

  async function storeAuthSession(input = {}) {
    if (!config.sessionsEnabled || !client) return false;
    const keyName = authSessionKey(input);
    if (!keyName) return false;
    const payload = {
      ...input,
      id: String(input.id ?? input.sessionId ?? "").trim(),
      sessionId: String(input.sessionId ?? input.id ?? "").trim(),
      userId: String(input.userId ?? "").trim(),
      deviceUuid: String(input.deviceUuid ?? "").trim(),
      tokenHash: String(input.tokenHash ?? "").trim(),
      clientApp: String(input.clientApp ?? "").trim(),
    };
    const ttlMs = Math.max(
      1,
      Math.min(
        config.sessionTtlMs,
        Number.isFinite(Date.parse(String(payload.expiresAt ?? "")))
          ? Date.parse(String(payload.expiresAt)) - Date.now()
          : config.sessionTtlMs,
      ),
    );
    const ok = await safeRedis(
      "auth session set",
      () => client.set(keyName, JSON.stringify(payload), ttlMs),
      null,
    );
    if (ok) metric("redisAuthSessionWrites");
    return Boolean(ok);
  }

  async function deleteAuthSessions(inputs = []) {
    if (!config.sessionsEnabled || !client) return false;
    const keys = [...new Set((Array.isArray(inputs) ? inputs : [inputs]).map(authSessionKey).filter(Boolean))];
    if (keys.length === 0) return true;
    const deleted = await safeRedis(
      "auth session delete",
      () => client.del(...keys),
      null,
    );
    if (deleted !== null) {
      metric("redisAuthSessionInvalidations", keys.length);
      return true;
    }
    metric("redisAuthSessionErrors");
    return false;
  }

  async function deleteAuthSession(input = {}) {
    return await deleteAuthSessions([input]);
  }

  async function deleteSession(input = {}) {
    if (!config.sessionsEnabled || !client) return false;
    const deviceUuid = normalizeKeyPart(input.deviceUuid, "");
    if (!deviceUuid) return false;
    const ok = await safeRedis(
      "session delete",
      () => client.del(key("device", deviceUuid, "session")),
      null,
    );
    if (ok) metric("redisSessionDeletes");
    return Boolean(ok);
  }

  return {
    get cacheEnabled() {
      return config.cacheEnabled && Boolean(client);
    },
    get enabled() {
      return config.enabled && Boolean(client);
    },
    get presenceEnabled() {
      return config.presenceEnabled && Boolean(client);
    },
    get sessionsEnabled() {
      return config.sessionsEnabled && Boolean(client);
    },
    authSessionKey,
    bumpCacheNamespace,
    cacheKey,
    close: () => client?.close?.(),
    deleteAuthSession,
    deleteAuthSessions,
    deleteSession,
    getAuthSession,
    getJson,
    getRedisClientStats: () => client?.getStats?.() ?? null,
    key,
    setJson,
    storeAuthSession,
    storeSession,
    touchPresence,
  };
}
