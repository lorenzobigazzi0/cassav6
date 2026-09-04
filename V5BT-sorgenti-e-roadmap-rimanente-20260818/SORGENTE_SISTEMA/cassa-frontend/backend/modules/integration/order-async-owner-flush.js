const OWNER_FLUSH_METRIC_LABEL = "orders.asyncFlush.ownerRemote.appStateWrite";

function normalizeIdList(...sources) {
  return [
    ...new Set(
      sources
        .flatMap((source) => (Array.isArray(source) ? source : [source]))
        .map((entry) =>
          entry && typeof entry === "object" ? (entry.orderId ?? entry.id) : entry,
        )
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeFieldNames(...sources) {
  return [
    ...new Set(
      sources
        .flatMap((source) => (Array.isArray(source) ? source : [source]))
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => /^[A-Za-z][A-Za-z0-9_]*$/.test(entry)),
    ),
  ];
}

function normalizeStringList(value, maxLength = 12, itemMaxLength = 80) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const next = String(raw ?? "").trim().slice(0, itemMaxLength);
    if (!next) continue;
    const key = next.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
    if (out.length >= maxLength) break;
  }
  return out;
}

export function buildRemoteOwnerFlushOptions(options = {}) {
  const safe = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  return {
    orderIds: normalizeIdList(safe.orderIds),
    auditEventIds: normalizeIdList(safe.auditEventIds),
    notificationIds: normalizeIdList(safe.notificationIds),
    fulfillmentHistoryIds: normalizeIdList(safe.fulfillmentHistoryIds),
    posSettingsTableIds: normalizeIdList(safe.posSettingsTableIds),
    integrationObjectFields: normalizeFieldNames(safe.integrationObjectFields),
    extraSplitDomains: normalizeStringList(safe.extraSplitDomains),
    syncSequence: safe.syncSequence === true,
    syncNotifications: safe.syncNotifications === true,
    syncFulfillmentHistory: safe.syncFulfillmentHistory === true,
    fulfillmentHistoryFullSync: safe.fulfillmentHistoryFullSync === true,
    syncPosSettings: safe.syncPosSettings === true,
    metricLabel: OWNER_FLUSH_METRIC_LABEL,
  };
}

export function createOrderAsyncOwnerFlushForwarder({
  enabled = false,
  getRole = () => "",
  ownerUrl = "",
  serviceToken = "",
  timeoutMs = 1_500,
  fetchWithTimeout,
  runtimeMetrics,
  logger = console,
} = {}) {
  const baseUrl = String(ownerUrl ?? "").trim().replace(/\/+$/, "");
  const active = enabled === true && Boolean(baseUrl) && String(serviceToken ?? "").length > 0;
  return {
    async forward(options = {}) {
      if (!active || getRole() !== "api-worker") return false;
      const startedAt = Date.now();
      runtimeMetrics?.incrementCounter?.("ordersAsyncFlushRemoteOwnerForwarded");
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/internal/orders/async-appstate-flush`, {
          method: "POST",
          timeoutMs,
          headers: {
            "Content-Type": "application/json",
            "X-Service-Token": serviceToken,
            "X-Cassav4-Internal": "orders-async-flush",
          },
          body: JSON.stringify({ options: buildRemoteOwnerFlushOptions(options) }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) throw new Error(`Owner flush HTTP ${response.status}`);
        runtimeMetrics?.incrementCounter?.("ordersAsyncFlushRemoteOwnerAccepted");
        runtimeMetrics?.recordOperation?.("orderWorkflow", "orders.asyncFlush.remoteOwner", Date.now() - startedAt);
        return true;
      } catch (error) {
        runtimeMetrics?.incrementCounter?.("ordersAsyncFlushRemoteOwnerFallbacks");
        logger?.warn?.(`[orders:async-flush] owner remoto non disponibile, fallback locale: ${error?.message ?? error}`);
        return false;
      }
    },
  };
}
