import { apiFetch, buildSseUrl } from "./baseUrl";

export type NotificationType = "waiter" | "bell" | "general";

export interface ServerNotification {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface NotificationClientContext {
  userId?: string | null;
  username?: string | null;
  fullName?: string | null;
  deviceUuid?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  lastEventId?: number | null;
}

const queue: ServerNotification[] = [];
const acked = new Set<string>();
const allowLocalNotificationFallback = () => import.meta.env.DEV;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

const normalizeContextPart = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");

const buildConsumerId = (context: NotificationClientContext = {}) => {
  const userPart = normalizeContextPart(String(context.userId ?? context.username ?? "anon"));
  const devicePart = normalizeContextPart(String(context.deviceUuid ?? "device")).slice(0, 24);
  return `mobile-frontend:${userPart || "anon"}:${devicePart || "device"}`;
};

const buildPullQuery = (context: NotificationClientContext = {}) => {
  const params = new URLSearchParams();
  params.set("consumer", buildConsumerId(context));
  params.set("clientApp", "mobile-frontend");
  const userId = String(context.userId ?? "").trim();
  const username = String(context.username ?? "").trim();
  const fullName = String(context.fullName ?? "").trim();
  const deviceUuid = String(context.deviceUuid ?? "").trim();
  const roomId = String(context.roomId ?? "").trim();
  const roomName = String(context.roomName ?? "").trim();
  const lastEventId = Math.max(0, Math.trunc(Number(context.lastEventId) || 0));
  if (userId) params.set("userId", userId);
  if (username) params.set("username", username);
  if (fullName) params.set("fullName", fullName);
  if (deviceUuid) params.set("deviceUuid", deviceUuid);
  if (roomId) params.set("roomId", roomId);
  if (roomName) params.set("roomName", roomName);
  if (lastEventId > 0) params.set("lastEventId", String(lastEventId));
  return params.toString();
};

export const buildNotificationStreamUrl = (
  context: NotificationClientContext = {},
  lastEventId = 0
) =>
  buildSseUrl(
    `/api/integration/notifications/stream?${buildPullQuery({
      ...context,
      lastEventId,
    })}`
  );

const normalizeIdentity = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const normalizeIdentityList = (value: unknown) =>
  Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => normalizeIdentity(entry)).filter(Boolean)))
    : [];

const normalizeRoomTargets = (meta: Record<string, unknown>) => {
  const room = meta.room;
  const roomRecord = room && typeof room === "object" ? (room as Record<string, unknown>) : null;
  return Array.from(
    new Set(
      [
        meta.targetRoomId,
        typeof room === "string" ? room : "",
        roomRecord?.id,
        roomRecord?.roomId,
        roomRecord?.name,
        roomRecord?.roomName,
      ]
        .map((entry) => normalizeIdentity(entry))
        .filter(Boolean)
    )
  );
};

const normalizeClientApp = (value: unknown) => {
  const normalized = normalizeIdentity(value).replace(/_/g, "-");
  if (["mobilefrontend", "posfrontend", "pos-frontend"].includes(normalized.replace(/-/g, ""))) {
    return "mobile-frontend";
  }
  return normalized;
};

const shouldAcceptNotification = (
  item: Record<string, unknown>,
  context: NotificationClientContext
) => {
  const rawMeta = item.meta;
  const meta = rawMeta && typeof rawMeta === "object" ? (rawMeta as Record<string, unknown>) : {};

  const targetUserId = String(meta.targetUserId ?? "").trim();
  const targetUserIds = normalizeIdentityList(meta.targetUserIds);
  const excludedUserIds = Array.from(
    new Set([
      ...normalizeIdentityList(meta.excludeUserIds),
      ...normalizeIdentityList(meta.excludedUserIds),
    ])
  );
  const targetUsername = normalizeIdentity(meta.targetUsername);
  const targetFullName = normalizeIdentity(meta.targetFullName);
  const targetDeviceUuid = String(meta.targetDeviceUuid ?? "").trim();
  const targetClientIp = String(meta.targetClientIp ?? "").trim();
  const targetDeviceAliases = Array.isArray(meta.targetDeviceIdAliases)
    ? meta.targetDeviceIdAliases.map((entry) => normalizeIdentity(entry)).filter(Boolean)
    : [];
  const eventType = normalizeIdentity(meta.eventType);
  const targetClientApp = normalizeClientApp(meta.targetClientApp);
  const targetFallbackActive =
    meta.targetFallbackActive === true ||
    normalizeIdentity(meta.targetFallbackScope) === "online_mobile";
  const serverTargetedHandheldRingByIp =
    eventType === "handheld_ring" &&
    targetClientApp === "mobile-frontend" &&
    Boolean(targetClientIp);

  const legacyWaiter = normalizeIdentity(meta.waiter);
  const fallbackTargetFullName =
    !targetUserId && !targetUsername && !targetFullName && !targetDeviceUuid && legacyWaiter
      ? legacyWaiter
      : "";

  const hasTarget = Boolean(
    targetUserId ||
    targetUserIds.length > 0 ||
    targetUsername ||
    targetFullName ||
    targetDeviceUuid ||
    targetDeviceAliases.length > 0 ||
    targetClientIp ||
    targetClientApp ||
    normalizeRoomTargets(meta).length > 0 ||
    fallbackTargetFullName
  );
  if (!hasTarget) return true;

  const ctxUserId = String(context.userId ?? "").trim();
  const ctxUserAliases = [normalizeIdentity(ctxUserId), normalizeIdentity(context.username)].filter(
    Boolean
  );
  const ctxUsername = normalizeIdentity(context.username);
  const ctxFullName = normalizeIdentity(context.fullName);
  const ctxDeviceUuid = String(context.deviceUuid ?? "").trim();
  const normalizedCtxDeviceUuid = normalizeIdentity(ctxDeviceUuid);
  const targetRooms = normalizeRoomTargets(meta);
  const contextRooms = [
    normalizeIdentity(context.roomId),
    normalizeIdentity(context.roomName),
  ].filter(Boolean);

  if (excludedUserIds.some((entry) => ctxUserAliases.includes(entry))) return false;
  const targetUserListMatches = targetUserIds.some((entry) => ctxUserAliases.includes(entry));
  if (targetUserIds.length > 0 && !targetUserListMatches) return false;
  if (targetRooms.length > 0 && !targetRooms.some((entry) => contextRooms.includes(entry))) {
    return false;
  }

  const hasFallbackEligibilityTarget = Boolean(
    targetUserId ||
    targetUserIds.length > 0 ||
    targetUsername ||
    targetFullName ||
    fallbackTargetFullName ||
    targetDeviceUuid ||
    targetDeviceAliases.length > 0 ||
    targetClientIp ||
    targetRooms.length > 0
  );
  if (targetFallbackActive && !hasFallbackEligibilityTarget) return false;

  const hasUserTarget = Boolean(
    targetUserId ||
    targetUserIds.length > 0 ||
    targetUsername ||
    targetFullName ||
    fallbackTargetFullName
  );
  if (hasUserTarget) {
    const userTargetMatches = Boolean(
      targetUserListMatches ||
      (targetUserId && targetUserId === ctxUserId) ||
      (targetUsername && targetUsername === ctxUsername) ||
      (targetFullName && targetFullName === ctxFullName) ||
      (fallbackTargetFullName && fallbackTargetFullName === ctxFullName)
    );
    if (!userTargetMatches && !targetFallbackActive) return false;
  }
  if (targetClientApp && targetClientApp !== "mobile-frontend") return false;
  if (
    !targetFallbackActive &&
    targetDeviceUuid &&
    normalizeIdentity(targetDeviceUuid) !== normalizedCtxDeviceUuid
  ) {
    const aliasMatches = targetDeviceAliases.includes(normalizedCtxDeviceUuid);
    if (!aliasMatches && !serverTargetedHandheldRingByIp) return false;
  }
  if (
    !targetFallbackActive &&
    targetDeviceAliases.length > 0 &&
    !targetDeviceAliases.includes(normalizedCtxDeviceUuid) &&
    !serverTargetedHandheldRingByIp
  )
    return false;
  if (!targetFallbackActive && targetClientIp && !serverTargetedHandheldRingByIp) return false;
  return true;
};

const normalizeServerNotificationCreatedAt = (value: unknown) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeServerNotificationItem = (item: Record<string, unknown>): ServerNotification => {
  const type =
    item.type === "waiter" || item.type === "bell" || item.type === "general"
      ? item.type
      : "general";
  const rawMeta = item.meta;
  const meta =
    rawMeta && typeof rawMeta === "object" ? (rawMeta as Record<string, unknown>) : undefined;
  return {
    id: String(item.id ?? makeId()),
    type,
    title: String(item.title ?? "Notifica"),
    description: String(item.description ?? ""),
    createdAt: normalizeServerNotificationCreatedAt(item.createdAt),
    ...(meta ? { meta } : {}),
  };
};

export function extractNotificationsFromStreamDetail(
  detail: Record<string, unknown>,
  context: NotificationClientContext = {}
): ServerNotification[] {
  const payloadDetail =
    detail.detail && typeof detail.detail === "object"
      ? (detail.detail as Record<string, unknown>)
      : detail;
  const rawItems = [
    payloadDetail.notification,
    ...(Array.isArray(payloadDetail.notifications) ? payloadDetail.notifications : []),
  ].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));

  return rawItems
    .filter((item) => shouldAcceptNotification(item, context))
    .map(normalizeServerNotificationItem);
}

async function backendPublishNotification(input: {
  type: NotificationType;
  title: string;
  description: string;
}): Promise<boolean> {
  try {
    const response = await apiFetch("/api/integration/notifications/publish", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function backendPullNotifications(
  context: NotificationClientContext = {}
): Promise<ServerNotification[] | null> {
  try {
    const query = buildPullQuery(context);
    const response = await apiFetch(`/api/integration/notifications/pull?${query}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { items?: unknown };
    if (!Array.isArray(payload.items)) return null;
    return payload.items
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .filter((item) => shouldAcceptNotification(item, context))
      .map(normalizeServerNotificationItem);
  } catch {
    return null;
  }
}

async function backendAckNotification(
  id: string,
  action: "ack" | "delete",
  context: NotificationClientContext = {}
): Promise<boolean> {
  try {
    const response = await apiFetch("/api/integration/notifications/ack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        id,
        consumer: buildConsumerId(context),
        action,
        userId: context.userId ?? "",
        username: context.username ?? "",
        fullName: context.fullName ?? "",
        deviceUuid: context.deviceUuid ?? "",
        roomId: context.roomId ?? "",
        roomName: context.roomName ?? "",
        clientApp: "mobile-frontend",
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function mockSendNotification(
  type: NotificationType,
  options: { title?: string; description?: string; count?: number } = {}
): Promise<void> {
  const count = Math.max(1, Number(options.count ?? 1));
  const title =
    options.title && options.title.trim().length > 0
      ? options.title.trim()
      : type === "waiter"
        ? "Chiamata cameriere"
        : type === "bell"
          ? "Comanda pronta"
          : "Notifica";
  const rawDescription =
    options.description && options.description.trim().length > 0
      ? options.description.trim()
      : "Dettaglio notifica in arrivo.";
  const description = rawDescription.slice(0, 140);
  for (let i = 0; i < count; i += 1) {
    const sent = await backendPublishNotification({ type, title, description });
    if (!sent && allowLocalNotificationFallback()) {
      queue.push({
        id: makeId(),
        type,
        title,
        description,
        createdAt: Date.now(),
      });
    }
  }
  await wait(80);
}

export async function fetchNotifications(
  context: NotificationClientContext = {}
): Promise<ServerNotification[]> {
  const backendItems = await backendPullNotifications(context);
  if (backendItems !== null) {
    return backendItems;
  }
  await wait(120);
  if (allowLocalNotificationFallback() && queue.length > 0) {
    return queue.splice(0, queue.length);
  }
  throw new Error("notification-backend-unavailable");
}

export async function acknowledgeNotification(
  id: string,
  context: NotificationClientContext = {}
): Promise<boolean> {
  const accepted = await backendAckNotification(id, "ack", context);
  await wait(30);
  if (accepted || allowLocalNotificationFallback()) acked.add(id);
  return accepted || allowLocalNotificationFallback();
}

export async function deleteNotification(
  id: string,
  context: NotificationClientContext = {}
): Promise<boolean> {
  const accepted = await backendAckNotification(id, "delete", context);
  await wait(30);
  if (accepted || allowLocalNotificationFallback()) acked.add(id);
  return accepted || allowLocalNotificationFallback();
}
