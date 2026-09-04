import { buildApiUrl } from "../api/baseUrl";
import {
  createRadioTxId,
  decodeRadioFrame,
  RADIO_FRAME_LIMITS,
  RADIO_PROTOCOL_VERSION,
  RADIO_WS_PATH,
} from "./radioProtocol";
import type {
  RadioAuthContext,
  RadioClientEvents,
  RadioConnectionStatus,
  RadioErrorMessage,
  RadioServerJsonMessage,
} from "./radioTypes";

type Listener<T> = (payload: T) => void;
type UnknownListener = (payload: unknown) => void;
type ListenerMap = Partial<Record<keyof RadioClientEvents, Set<UnknownListener>>>;

const BASE_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 15_000;
const READY_TIMEOUT_MS = 20_000;
const RECONNECT_JITTER_MS = 350;

function resolveBrowserOrigin() {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "http://127.0.0.1";
}

export function buildRadioWebSocketUrl(path = RADIO_WS_PATH) {
  const apiUrl = buildApiUrl(path);
  const url = new URL(apiUrl, resolveBrowserOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function asBinaryData(data: unknown): ArrayBuffer | Uint8Array | null {
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data;
  if (data instanceof Blob) return null;
  return null;
}

function parseJsonMessage(data: unknown): RadioServerJsonMessage | null {
  try {
    const raw = typeof data === "string" ? data : "";
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const type = String((parsed as { type?: unknown }).type ?? "");
    return type ? (parsed as RadioServerJsonMessage) : null;
  } catch {
    return null;
  }
}

export class RadioWsClient {
  private auth: RadioAuthContext | null = null;
  private desiredChannelIds = new Set<string>();
  private listeners: ListenerMap = {};
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private readyTimer: number | null = null;
  private reconnectAttempt = 0;
  private explicitDisconnect = false;
  private status: RadioConnectionStatus = "disconnected";
  private activeStreamId: number | null = null;
  private activeTxId: string | null = null;

  on<K extends keyof RadioClientEvents>(
    event: K,
    listener: Listener<RadioClientEvents[K]>
  ): () => void {
    const bucket = (this.listeners[event] ??= new Set<UnknownListener>());
    const typedListener = listener as UnknownListener;
    bucket.add(typedListener);
    return () => bucket.delete(typedListener);
  }

  connect(auth: RadioAuthContext, channelIds: string[] = []) {
    this.auth = auth;
    this.explicitDisconnect = false;
    this.desiredChannelIds = new Set(channelIds.filter(Boolean));
    this.openSocket("connecting");
  }

  disconnect() {
    this.explicitDisconnect = true;
    this.auth = null;
    this.activeStreamId = null;
    this.activeTxId = null;
    this.clearReconnectTimer();
    this.clearReadyTimer();
    this.socket?.close();
    this.socket = null;
    this.setStatus("disconnected");
  }

  subscribe(channelIds: string[]) {
    this.desiredChannelIds = new Set(channelIds.filter(Boolean));
    if (this.status === "ready") {
      this.sendJson({
        type: "subscribe",
        channelIds: [...this.desiredChannelIds],
      });
    }
  }

  startPtt(channelId: string, txId = createRadioTxId("tx")) {
    if (this.status !== "ready") return null;
    this.sendJson({
      type: "ptt:start",
      txId,
      channelId,
      codec: RADIO_FRAME_LIMITS.codec,
      sampleRate: RADIO_FRAME_LIMITS.sampleRate,
      frameMs: RADIO_FRAME_LIMITS.frameMs,
    });
    return txId;
  }

  stopPtt(txId = this.activeTxId ?? "") {
    if (!txId) return;
    this.sendJson({
      type: "ptt:stop",
      txId,
    });
    this.activeStreamId = null;
    this.activeTxId = null;
  }

  startEcho(txId = createRadioTxId("echo")) {
    if (this.status !== "ready") return null;
    this.sendJson({
      type: "echo:start",
      txId,
      codec: RADIO_FRAME_LIMITS.codec,
      sampleRate: RADIO_FRAME_LIMITS.sampleRate,
      frameMs: RADIO_FRAME_LIMITS.frameMs,
    });
    return txId;
  }

  stopEcho(txId = this.activeTxId ?? "") {
    if (!txId) return;
    this.sendJson({
      type: "echo:stop",
      txId,
    });
    this.activeStreamId = null;
    this.activeTxId = null;
  }

  sendAudioFrame(frame: Uint8Array) {
    const decoded = decodeRadioFrame(frame);
    if (!decoded || this.activeStreamId === null || decoded.streamId !== this.activeStreamId) {
      return false;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > RADIO_FRAME_LIMITS.maxBufferedBytes) return false;
    this.socket.send(frame);
    return true;
  }

  getStatus() {
    return this.status;
  }

  private openSocket(status: RadioConnectionStatus) {
    if (!this.auth) {
      this.setStatus("disabled");
      return;
    }
    this.clearReconnectTimer();
    this.clearReadyTimer();
    this.socket?.close();
    this.socket = null;
    this.setStatus(status);

    const socket = new WebSocket(buildRadioWebSocketUrl());
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (!this.auth) return;
      this.reconnectAttempt = 0;
      this.armReadyTimer(socket);
      this.sendJson({
        type: "hello",
        token: this.auth.token,
        userId: this.auth.userId,
        deviceUuid: this.auth.deviceUuid,
        clientApp: this.auth.clientApp || "mobile-frontend",
        protocolVersion: RADIO_PROTOCOL_VERSION,
      });
    });

    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.activeStreamId = null;
      this.activeTxId = null;
      this.clearReadyTimer();
      if (this.explicitDisconnect) {
        this.setStatus("disconnected");
        return;
      }
      const unauthorizedClose = event.code === 1008;
      if (!this.auth || unauthorizedClose) {
        this.setStatus(unauthorizedClose ? "error" : "disconnected", unauthorizedClose ? "Radio non autorizzata." : undefined);
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.emit("status", { status: "error", error: "Connessione radio non disponibile." });
    });
  }

  private scheduleReconnect() {
    if (!this.auth || this.explicitDisconnect) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const baseDelay = BASE_RECONNECT_MS * 2 ** attempt;
    const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
    const delay = Math.min(MAX_RECONNECT_MS, baseDelay + jitter);
    this.setStatus("reconnecting");
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.auth && !this.explicitDisconnect) {
        this.openSocket("reconnecting");
      }
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armReadyTimer(socket: WebSocket) {
    this.clearReadyTimer();
    this.readyTimer = window.setTimeout(() => {
      if (this.socket !== socket || this.status === "ready" || this.explicitDisconnect) return;
      try {
        socket.close();
      } catch {
        // Closing a stale WebSocket is best-effort.
      }
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleReconnect();
      }
    }, READY_TIMEOUT_MS);
  }

  private clearReadyTimer() {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private async handleMessage(data: unknown) {
    const binaryData = asBinaryData(data);
    if (binaryData) {
      const frame = decodeRadioFrame(binaryData);
      if (frame) {
        this.emit("audioFrame", {
          streamId: frame.streamId,
          frame: binaryData instanceof Uint8Array ? binaryData : new Uint8Array(binaryData),
        });
      }
      return;
    }
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      const frame = decodeRadioFrame(buffer);
      if (frame) {
        this.emit("audioFrame", {
          streamId: frame.streamId,
          frame: new Uint8Array(buffer),
        });
      }
      return;
    }
    const message = parseJsonMessage(data);
    if (!message) return;
    this.handleJsonMessage(message);
  }

  private handleJsonMessage(message: RadioServerJsonMessage) {
    if (message.type === "ready") {
      this.clearReadyTimer();
      this.setStatus("ready");
      this.emit("ready", message);
      this.subscribe([...this.desiredChannelIds]);
    } else if (message.type === "subscribed") {
      this.emit("subscribed", message);
    } else if (message.type === "ptt:grant") {
      this.activeStreamId = message.streamId;
      this.activeTxId = message.txId;
      this.emit("pttGrant", message);
    } else if (message.type === "ptt:busy") {
      this.activeStreamId = null;
      this.activeTxId = null;
      this.emit("pttBusy", message);
    } else if (message.type === "ptt:incoming-start") {
      this.emit("incomingStart", message);
    } else if (message.type === "ptt:incoming-stop") {
      this.emit("incomingStop", message);
    } else if (message.type === "echo:grant") {
      this.activeStreamId = message.streamId;
      this.activeTxId = message.txId;
      this.emit("echoGrant", message);
    } else if (message.type === "echo:stop") {
      this.activeStreamId = null;
      this.activeTxId = null;
      this.emit("echoStop", message);
    } else if (message.type === "error") {
      this.emit("error", message);
    }
  }

  private sendJson(message: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private setStatus(status: RadioConnectionStatus, error?: string) {
    this.status = status;
    this.emit("status", { status, ...(error ? { error } : {}) });
  }

  private emit<K extends keyof RadioClientEvents>(event: K, payload: RadioClientEvents[K]) {
    const bucket = this.listeners[event];
    if (!bucket) return;
    for (const listener of bucket) {
      listener(payload);
    }
  }
}

export function createRadioWsClient() {
  return new RadioWsClient();
}

export function normalizeRadioErrorMessage(message: RadioErrorMessage | null | undefined) {
  return String(message?.message ?? "").trim() || "Errore radio.";
}
