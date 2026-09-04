import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  normalizeRadioChannelId,
  sanitizeRadioChannels,
} from "./radio.domain.js";
import {
  formatRadioSpeakerName,
  isSupportedRadioCodec,
  parseRadioFrame,
  parseRadioJsonMessage,
  RADIO_LIMITS,
  RADIO_PROTOCOL_VERSION,
  stringifyRadioJsonMessage,
} from "./radio-protocol.js";

const DEFAULT_HELLO_TIMEOUT_MS = 15000;
const DEFAULT_IDLE_TIMEOUT_MS = 12000;
const DEFAULT_ECHO_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_ECHO_STOP_FLUSH_MS = 120;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_CHANNEL_CACHE_TTL_MS = 30000;
const MAX_PENDING_FORWARD_FRAMES = 12;
const FORWARD_BATCH_FRAMES = 4;
const BACKGROUND_RADIO_CLIENT_APP = "android-background-radio";

function clientId() {
  return `rc_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function txIdFallback() {
  return `tx_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function streamIdFromCounter(counter) {
  return counter > 0xffffffff ? 1 : counter;
}

function userFullName(user) {
  return (
    String(user?.fullName ?? "").trim() ||
    String(user?.displayName ?? "").trim() ||
    [user?.firstName, user?.lastName]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" ") ||
    String(user?.name ?? "").trim() ||
    String(user?.username ?? user?.id ?? "").trim()
  );
}

function buildSpeaker(client) {
  return {
    userId: client.userId,
    displayName: formatRadioSpeakerName(client.fullName, client.username),
    fullName: client.fullName || client.username || "Operatore",
  };
}

function isOpen(ws) {
  return ws?.readyState === 1;
}

function normalizeClientApp(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isBackgroundRadioClient(client) {
  if (normalizeClientApp(client?.clientApp) === BACKGROUND_RADIO_CLIENT_APP)
    return true;
  return /\bokhttp\b/i.test(String(client?.userAgent ?? ""));
}

function choosePreferredRadioReceiver(current, candidate) {
  if (!current) return candidate;
  const currentBackground = isBackgroundRadioClient(current);
  const candidateBackground = isBackgroundRadioClient(candidate);
  if (currentBackground && !candidateBackground) {
    return current;
  }
  if (!currentBackground && candidateBackground) {
    return candidate;
  }
  // When both sockets have the same class, prefer the latest subscription.
  return candidate;
}

function safeSendJson(client, message) {
  if (!isOpen(client.ws)) return false;
  client.ws.send(stringifyRadioJsonMessage(message));
  return true;
}

export function isRadioSocketBackpressured(ws, limits = RADIO_LIMITS) {
  return (
    Number(ws?.bufferedAmount ?? 0) >
    Number(limits?.maxBufferedBytes ?? RADIO_LIMITS.maxBufferedBytes)
  );
}

function safeSendBinary(client, buffer, limits) {
  if (!isOpen(client.ws)) return false;
  if (isRadioSocketBackpressured(client.ws, limits)) return false;
  client.ws.send(buffer, { binary: true });
  return true;
}

function normalizePositiveTimeoutMs(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

function normalizeNonNegativeDurationMs(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 0 ? timeout : fallback;
}

export function createRadioHub({
  readDb,
  sanitizePosSettings,
  validateSessionContext,
  nowIso = () => new Date().toISOString(),
  logger = console,
  limits = RADIO_LIMITS,
  helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  echoIdleTimeoutMs = DEFAULT_ECHO_IDLE_TIMEOUT_MS,
  echoStopFlushMs = DEFAULT_ECHO_STOP_FLUSH_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  channelCacheTtlMs = DEFAULT_CHANNEL_CACHE_TTL_MS,
} = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxFrameBytes + 4096,
  });
  const clientsById = new Map();
  const subscriberIdsByChannelId = new Map();
  const activeTxByChannelId = new Map();
  const activeTxByStreamId = new Map();
  let nextStreamId = Math.floor(Math.random() * 0xfffffff) + 1;
  let closed = false;
  let enabledChannelMapCache = null;
  let enabledChannelMapCacheUntilMs = 0;
  let enabledChannelMapRefreshPromise = null;
  const channelIdleTimeoutMs = normalizePositiveTimeoutMs(
    idleTimeoutMs,
    DEFAULT_IDLE_TIMEOUT_MS,
  );
  const echoIdleTimeoutMsResolved = normalizePositiveTimeoutMs(
    echoIdleTimeoutMs,
    DEFAULT_ECHO_IDLE_TIMEOUT_MS,
  );
  const echoStopFlushMsResolved = normalizePositiveTimeoutMs(
    echoStopFlushMs,
    DEFAULT_ECHO_STOP_FLUSH_MS,
  );
  const channelCacheTtlMsResolved = normalizeNonNegativeDurationMs(
    channelCacheTtlMs,
    DEFAULT_CHANNEL_CACHE_TTL_MS,
  );

  function nowMs() {
    return Date.now();
  }

  function nextStream() {
    nextStreamId = streamIdFromCounter(nextStreamId + 1);
    while (activeTxByStreamId.has(nextStreamId)) {
      nextStreamId = streamIdFromCounter(nextStreamId + 1);
    }
    return nextStreamId;
  }

  async function refreshEnabledChannelMap() {
    const db = await readDb();
    const settings = sanitizePosSettings(db?.posSettings, {
      menuItems: db?.menuItems,
      users: db?.users,
    });
    const channels = sanitizeRadioChannels(settings?.radioChannels).filter(
      (channel) => channel.enabled,
    );
    const channelMap = new Map(
      channels.map((channel) => [channel.id, channel]),
    );
    enabledChannelMapCache = channelMap;
    enabledChannelMapCacheUntilMs = nowMs() + channelCacheTtlMsResolved;
    return channelMap;
  }

  function refreshEnabledChannelMapInBackground() {
    if (enabledChannelMapRefreshPromise) return;
    enabledChannelMapRefreshPromise = refreshEnabledChannelMap()
      .catch((error) => {
        logger?.warn?.("[radio] refresh canali fallito", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        enabledChannelMapRefreshPromise = null;
      });
  }

  async function loadEnabledChannelMap({ allowStale = false } = {}) {
    const cacheNow = nowMs();
    if (
      channelCacheTtlMsResolved > 0 &&
      enabledChannelMapCache &&
      cacheNow < enabledChannelMapCacheUntilMs
    ) {
      return enabledChannelMapCache;
    }
    if (allowStale && enabledChannelMapCache) {
      refreshEnabledChannelMapInBackground();
      return enabledChannelMapCache;
    }
    return refreshEnabledChannelMap();
  }

  function sendError(client, code, message, extra = {}) {
    safeSendJson(client, {
      type: "error",
      code,
      message,
      ...extra,
    });
  }

  function removeClientSubscriptions(client) {
    if (!client?.subscribedChannelIds) return;
    for (const channelId of client.subscribedChannelIds) {
      const subscriberIds = subscriberIdsByChannelId.get(channelId);
      if (!subscriberIds) continue;
      subscriberIds.delete(client.id);
      if (subscriberIds.size === 0) {
        subscriberIdsByChannelId.delete(channelId);
      }
    }
    client.subscribedChannelIds = new Set();
  }

  function setClientSubscriptions(client, channelIds) {
    removeClientSubscriptions(client);
    client.subscribedChannelIds = new Set(channelIds);
    for (const channelId of client.subscribedChannelIds) {
      let subscriberIds = subscriberIdsByChannelId.get(channelId);
      if (!subscriberIds) {
        subscriberIds = new Set();
        subscriberIdsByChannelId.set(channelId, subscriberIds);
      }
      subscriberIds.add(client.id);
    }
  }

  function forEachSubscribedClient(
    channelId,
    exceptClientId,
    exceptDeviceUuid,
    callback,
  ) {
    const subscriberIds = subscriberIdsByChannelId.get(channelId);
    if (!subscriberIds || subscriberIds.size === 0) return;
    const receiversByDeviceUuid = new Map();
    const receiversWithoutDeviceUuid = [];
    for (const receiverId of subscriberIds) {
      if (receiverId === exceptClientId) continue;
      const receiver = clientsById.get(receiverId);
      if (!receiver?.authenticated || !isOpen(receiver.ws)) {
        subscriberIds.delete(receiverId);
        continue;
      }
      if (
        exceptDeviceUuid &&
        receiver.deviceUuid &&
        receiver.deviceUuid === exceptDeviceUuid
      ) {
        continue;
      }
      const receiverDeviceUuid = String(receiver.deviceUuid ?? "").trim();
      if (!receiverDeviceUuid) {
        receiversWithoutDeviceUuid.push(receiver);
        continue;
      }
      receiversByDeviceUuid.set(
        receiverDeviceUuid,
        choosePreferredRadioReceiver(
          receiversByDeviceUuid.get(receiverDeviceUuid),
          receiver,
        ),
      );
    }
    if (subscriberIds.size === 0) {
      subscriberIdsByChannelId.delete(channelId);
    }
    for (const receiver of receiversByDeviceUuid.values()) callback(receiver);
    for (const receiver of receiversWithoutDeviceUuid) callback(receiver);
  }

  function broadcastIncomingStart(tx) {
    const message = {
      type: "ptt:incoming-start",
      streamId: tx.streamId,
      channelId: tx.channelId,
      channelName: tx.channelName,
      channelColor: tx.channelColor,
      speaker: tx.speaker,
      codec: limits.codec,
      sampleRate: limits.sampleRate,
      frameMs: limits.frameMs,
      startedAt: tx.startedAt,
    };
    forEachSubscribedClient(
      tx.channelId,
      tx.clientId,
      tx.deviceUuid,
      (receiver) => {
        safeSendJson(receiver, message);
      },
    );
  }

  function broadcastIncomingStop(tx, reason) {
    if (!tx.channelId) return;
    const stoppedAt = nowMs();
    const message = {
      type: "ptt:incoming-stop",
      streamId: tx.streamId,
      channelId: tx.channelId,
      stoppedAt,
      reason,
    };
    forEachSubscribedClient(
      tx.channelId,
      tx.clientId,
      tx.deviceUuid,
      (receiver) => {
        safeSendJson(receiver, message);
      },
    );
  }

  function clearClientActiveStream(client, tx) {
    if (client?.activeStreamId === tx.streamId) {
      client.activeStreamId = null;
      client.activeTxId = null;
    }
  }

  function flushPttFrameQueue(tx, frameLimit = FORWARD_BATCH_FRAMES) {
    if (!tx?.channelId || !Array.isArray(tx.pendingFrameBuffers)) return 0;
    const count = Math.min(
      tx.pendingFrameBuffers.length,
      Math.max(0, frameLimit),
    );
    if (count === 0) return 0;
    const frames = tx.pendingFrameBuffers.splice(0, count);
    for (const frameBuffer of frames) {
      forEachSubscribedClient(
        tx.channelId,
        tx.clientId,
        tx.deviceUuid,
        (receiver) => {
          safeSendBinary(receiver, frameBuffer, limits);
        },
      );
    }
    return frames.length;
  }

  function stopTx(tx, reason = "speaker_stop") {
    if (!tx || !activeTxByStreamId.has(tx.streamId)) return;
    if (tx.finalizeTimer) {
      clearTimeout(tx.finalizeTimer);
      tx.finalizeTimer = null;
    }
    flushPttFrameQueue(tx, Number.POSITIVE_INFINITY);
    tx.pendingFrameBuffers = [];
    activeTxByStreamId.delete(tx.streamId);
    if (tx.channelId) {
      const current = activeTxByChannelId.get(tx.channelId);
      if (current?.streamId === tx.streamId) {
        activeTxByChannelId.delete(tx.channelId);
      }
      broadcastIncomingStop(tx, reason);
    } else if (tx.echo) {
      const client = clientsById.get(tx.clientId);
      if (client) {
        safeSendJson(client, {
          type: "echo:stop",
          txId: tx.txId,
          streamId: tx.streamId,
          stoppedAt: nowMs(),
          reason,
        });
      }
    }
    clearClientActiveStream(clientsById.get(tx.clientId), tx);
  }

  function stopClientTx(client, reason) {
    if (!client?.activeStreamId) return;
    stopTx(activeTxByStreamId.get(client.activeStreamId), reason);
  }

  function scheduleEchoStop(tx, reason = "speaker_stop") {
    if (!tx?.echo) return;
    if (tx.finalizeTimer) return;
    tx.finalizeTimer = setTimeout(() => {
      tx.finalizeTimer = null;
      stopTx(tx, reason);
    }, echoStopFlushMsResolved);
    tx.finalizeTimer.unref?.();
  }

  function resolveIdleTimeoutMs(tx) {
    return tx?.echo ? echoIdleTimeoutMsResolved : channelIdleTimeoutMs;
  }

  function cleanupClient(client, reason = "socket_closed") {
    clearTimeout(client.helloTimer);
    stopClientTx(client, reason);
    removeClientSubscriptions(client);
    clientsById.delete(client.id);
  }

  function rejectUpgrade(socket, statusCode = 400, message = "Bad Request") {
    try {
      socket.write(
        `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`,
      );
    } catch {
      // Socket may already be closed by the peer.
    }
    socket.destroy();
  }

  async function handleHello(client, message) {
    if (client.authenticated) return;
    if (
      Number(message?.protocolVersion ?? RADIO_PROTOCOL_VERSION) !==
      RADIO_PROTOCOL_VERSION
    ) {
      sendError(
        client,
        "unsupported_protocol",
        "Protocollo radio non supportato.",
      );
      client.ws.close(1002, "unsupported_protocol");
      return;
    }
    try {
      const db = await readDb();
      const { user, session } = validateSessionContext(db, message);
      client.authenticated = true;
      client.userId = String(user?.id ?? session?.userId ?? "").trim();
      client.username = String(user?.username ?? user?.id ?? "").trim();
      client.fullName = userFullName(user);
      client.deviceUuid = String(
        message?.deviceUuid ?? session?.deviceUuid ?? "",
      ).trim();
      client.clientApp =
        normalizeClientApp(message?.clientApp) || "mobile-frontend";
      clearTimeout(client.helloTimer);
      safeSendJson(client, {
        type: "ready",
        protocolVersion: RADIO_PROTOCOL_VERSION,
        clientId: client.id,
        serverTime: nowMs(),
        limits,
      });
    } catch {
      sendError(client, "unauthorized", "Sessione login richiesta.");
      client.ws.close(1008, "unauthorized");
    }
  }

  async function handleSubscribe(client, message) {
    if (!client.authenticated) {
      sendError(client, "unauthorized", "Sessione login richiesta.");
      return;
    }
    const channels = await loadEnabledChannelMap({ allowStale: true });
    const subscribed = [];
    for (const rawChannelId of Array.isArray(message?.channelIds)
      ? message.channelIds
      : []) {
      const channelId = normalizeRadioChannelId(rawChannelId);
      if (
        !channelId ||
        !channels.has(channelId) ||
        subscribed.includes(channelId)
      )
        continue;
      subscribed.push(channelId);
    }
    setClientSubscriptions(client, subscribed);
    safeSendJson(client, {
      type: "subscribed",
      channelIds: subscribed,
    });
  }

  function validateStartMessage(client, message) {
    if (!client.authenticated) {
      sendError(client, "unauthorized", "Sessione login richiesta.");
      return false;
    }
    if (client.activeStreamId) {
      sendError(
        client,
        "already_transmitting",
        "Trasmissione radio gia attiva.",
      );
      return false;
    }
    if (!isSupportedRadioCodec(message)) {
      sendError(client, "unsupported_codec", "Codec radio non supportato.");
      return false;
    }
    return true;
  }

  async function handlePttStart(client, message) {
    if (!validateStartMessage(client, message)) return;
    const channels = await loadEnabledChannelMap({ allowStale: true });
    const channelId = normalizeRadioChannelId(message?.channelId);
    const channel = channels.get(channelId);
    const txId =
      String(message?.txId ?? txIdFallback()).trim() || txIdFallback();
    if (!channel) {
      sendError(client, "channel_not_found", "Canale radio non disponibile.", {
        txId,
        channelId,
      });
      return;
    }
    if (!client.subscribedChannelIds.has(channelId)) {
      sendError(client, "not_subscribed", "Canale radio non sottoscritto.", {
        txId,
        channelId,
      });
      return;
    }
    const activeTx = activeTxByChannelId.get(channelId);
    if (activeTx) {
      safeSendJson(client, {
        type: "ptt:busy",
        txId,
        channelId,
        activeSpeaker: activeTx.speaker,
        message: "Canale occupato",
      });
      return;
    }
    const streamId = nextStream();
    const startedAt = nowMs();
    const tx = {
      streamId,
      txId,
      channelId,
      channelName: channel.name,
      channelColor: channel.color,
      clientId: client.id,
      userId: client.userId,
      deviceUuid: client.deviceUuid,
      speaker: buildSpeaker(client),
      startedAt,
      lastFrameAt: startedAt,
      echo: false,
      pendingFrameBuffers: [],
      frameForwardScheduled: false,
    };
    activeTxByChannelId.set(channelId, tx);
    activeTxByStreamId.set(streamId, tx);
    client.activeStreamId = streamId;
    client.activeTxId = txId;
    safeSendJson(client, {
      type: "ptt:grant",
      txId,
      streamId,
      channelId,
      startedAt,
    });
    broadcastIncomingStart(tx);
  }

  function handlePttStop(client, message) {
    if (!client.authenticated || !client.activeStreamId) return;
    const tx = activeTxByStreamId.get(client.activeStreamId);
    if (!tx || tx.echo) return;
    const txId = String(message?.txId ?? "").trim();
    if (txId && txId !== tx.txId) return;
    stopTx(tx, "speaker_stop");
  }

  function handleEchoStart(client, message) {
    if (!validateStartMessage(client, message)) return;
    const txId =
      String(message?.txId ?? txIdFallback()).trim() || txIdFallback();
    const streamId = nextStream();
    const startedAt = nowMs();
    const tx = {
      streamId,
      txId,
      channelId: "",
      channelName: "",
      channelColor: "",
      clientId: client.id,
      userId: client.userId,
      deviceUuid: client.deviceUuid,
      speaker: buildSpeaker(client),
      startedAt,
      lastFrameAt: startedAt,
      echo: true,
      finalizeTimer: null,
      pendingFrameBuffers: [],
      frameForwardScheduled: false,
    };
    activeTxByStreamId.set(streamId, tx);
    client.activeStreamId = streamId;
    client.activeTxId = txId;
    safeSendJson(client, {
      type: "echo:grant",
      txId,
      streamId,
      startedAt,
    });
  }

  function handleEchoStop(client, message) {
    if (!client.authenticated || !client.activeStreamId) return;
    const tx = activeTxByStreamId.get(client.activeStreamId);
    if (!tx?.echo) return;
    const txId = String(message?.txId ?? "").trim();
    if (txId && txId !== tx.txId) return;
    scheduleEchoStop(tx, "speaker_stop");
  }

  function armPttFrameForward(tx) {
    if (tx.frameForwardScheduled) return;
    tx.frameForwardScheduled = true;
    setImmediate(() => {
      tx.frameForwardScheduled = false;
      if (!activeTxByStreamId.has(tx.streamId)) {
        tx.pendingFrameBuffers = [];
        return;
      }
      flushPttFrameQueue(tx);
      if (tx.pendingFrameBuffers.length > 0) {
        armPttFrameForward(tx);
      }
    });
  }

  function schedulePttFrameForward(tx, buffer) {
    if (!Array.isArray(tx.pendingFrameBuffers)) tx.pendingFrameBuffers = [];
    if (tx.pendingFrameBuffers.length >= MAX_PENDING_FORWARD_FRAMES) {
      tx.pendingFrameBuffers.splice(
        0,
        tx.pendingFrameBuffers.length - MAX_PENDING_FORWARD_FRAMES + 1,
      );
    }
    tx.pendingFrameBuffers.push(buffer);
    armPttFrameForward(tx);
  }

  async function handleJsonMessage(client, data) {
    const message = parseRadioJsonMessage(data);
    if (!message?.type) {
      sendError(client, "invalid_message", "Messaggio radio non valido.");
      return;
    }
    try {
      if (message.type === "hello") {
        await handleHello(client, message);
      } else if (message.type === "subscribe") {
        await handleSubscribe(client, message);
      } else if (message.type === "ptt:start") {
        await handlePttStart(client, message);
      } else if (message.type === "ptt:stop") {
        handlePttStop(client, message);
      } else if (message.type === "echo:start") {
        handleEchoStart(client, message);
      } else if (message.type === "echo:stop") {
        handleEchoStop(client, message);
      }
    } catch (error) {
      logger?.warn?.("[radio] message handling failed", {
        type: message.type,
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(client, "server_error", "Errore radio backend.");
    }
  }

  function handleBinaryMessage(client, data) {
    if (!client.authenticated) return;
    const frame = parseRadioFrame(data, limits);
    if (!frame) return;
    const tx = activeTxByStreamId.get(frame.streamId);
    if (!tx || tx.clientId !== client.id) return;
    tx.lastFrameAt = nowMs();
    if (tx.echo) {
      safeSendBinary(client, frame.buffer, limits);
      return;
    }
    schedulePttFrameForward(tx, frame.buffer);
  }

  function handleConnection(ws, req) {
    ws?._socket?.setNoDelay?.(true);
    ws?._socket?.setKeepAlive?.(true);
    const client = {
      id: clientId(),
      ws,
      authenticated: false,
      userId: "",
      username: "",
      fullName: "",
      deviceUuid: "",
      clientApp: "",
      userAgent: String(req?.headers?.["user-agent"] ?? "").trim(),
      subscribedChannelIds: new Set(),
      activeStreamId: null,
      activeTxId: null,
      isAlive: true,
      helloTimer: null,
    };
    clientsById.set(client.id, client);
    client.helloTimer = setTimeout(() => {
      if (client.authenticated) return;
      sendError(client, "hello_timeout", "Hello radio non ricevuto.");
      client.ws.close(1008, "hello_timeout");
    }, helloTimeoutMs);
    client.helloTimer.unref?.();

    ws.on("pong", () => {
      client.isAlive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        handleBinaryMessage(client, data);
      } else {
        void handleJsonMessage(client, data);
      }
    });
    ws.on("close", () => cleanupClient(client, "socket_closed"));
    ws.on("error", () => cleanupClient(client, "error"));
  }

  wss.on("connection", handleConnection);

  const idleTimer = setInterval(
    () => {
      const now = nowMs();
      for (const tx of [...activeTxByStreamId.values()]) {
        if (now - tx.lastFrameAt > resolveIdleTimeoutMs(tx)) {
          stopTx(tx, "idle_timeout");
        }
      }
    },
    Math.max(
      250,
      Math.min(channelIdleTimeoutMs, echoIdleTimeoutMsResolved, 1000),
    ),
  );
  idleTimer.unref?.();

  const heartbeatTimer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          for (const client of [...clientsById.values()]) {
            if (!isOpen(client.ws)) continue;
            if (client.isAlive === false) {
              client.ws.terminate();
              cleanupClient(client, "socket_closed");
              continue;
            }
            client.isAlive = false;
            client.ws.ping();
          }
        }, heartbeatIntervalMs)
      : null;
  heartbeatTimer?.unref?.();

  return {
    handleUpgrade(req, socket, head) {
      if (!req || !socket) return false;
      if (socket.destroyed) return false;
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
        return true;
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return false;
      }
    },
    getSnapshot() {
      return {
        clients: clientsById.size,
        activeTransmissions: activeTxByStreamId.size,
        activeChannels: [...activeTxByChannelId.keys()],
      };
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(idleTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const client of [...clientsById.values()]) {
        cleanupClient(client, "server_shutdown");
        try {
          client.ws.terminate();
        } catch {
          // Ignore close races during shutdown.
        }
      }
      wss.close();
    },
  };
}
