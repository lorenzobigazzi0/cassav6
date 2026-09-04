function normalizeJobIds(source, maxItems = 1_000) {
  const entries = Array.isArray(source) ? source : [];
  const ids = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = String(entry && typeof entry === "object" ? (entry.key ?? entry.id) : entry ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= maxItems) break;
  }
  return ids;
}

export function buildPrintSpoolLegacyMirrorOwnerPayload(source) {
  return { jobIds: normalizeJobIds(source) };
}

export function createPrintSpoolLegacyMirrorOwnerForwarder({
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
  const active = enabled === true && Boolean(baseUrl) && Boolean(String(serviceToken ?? ""));
  return {
    async forward(batch = []) {
      if (!active || getRole() !== "api-worker") return false;
      const payload = buildPrintSpoolLegacyMirrorOwnerPayload(batch);
      if (payload.jobIds.length === 0) return true;
      const startedAt = Date.now();
      runtimeMetrics?.incrementCounter?.("printSpoolLegacyMirrorRemoteOwnerForwarded");
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/internal/print-spool/legacy-mirror`, {
          method: "POST",
          timeoutMs,
          headers: {
            "Content-Type": "application/json",
            "X-Service-Token": serviceToken,
            "X-Cassav4-Internal": "print-spool-legacy-mirror",
          },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.ok !== true) throw new Error(`Owner mirror HTTP ${response.status}`);
        runtimeMetrics?.incrementCounter?.("printSpoolLegacyMirrorRemoteOwnerAccepted");
        runtimeMetrics?.recordOperation?.("queue", "printSpoolLegacyMirror.remoteOwner", Date.now() - startedAt);
        return true;
      } catch (error) {
        runtimeMetrics?.incrementCounter?.("printSpoolLegacyMirrorRemoteOwnerFallbacks");
        logger?.warn?.(`[print-spool:legacy-mirror] owner remoto non disponibile, fallback locale: ${error?.message ?? error}`);
        return false;
      }
    },
  };
}
