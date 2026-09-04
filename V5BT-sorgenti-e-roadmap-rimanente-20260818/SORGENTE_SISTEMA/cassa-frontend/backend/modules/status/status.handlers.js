import { buildHandheldSessionReport } from "../reports/handheld-session-report.js";
import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

export function createStatusHandlers({
  applyMonitorControl,
  createControlError,
  readMonitorOverviewView,
  resolveHealthSettingsVersion,
  normalizeText,
  normalizeUrl,
  readOrderWorkflowSettingsView,
  readPaymentMethodsSettingsView,
  readPaymentTerminalsSettingsView,
  appEnv,
  backendProcessRole = "",
  buildIntegrationStationStatesWithSessionRecovery,
  checkPersistenceHealth,
  checkPostgresqlHealth,
  fetchWithTimeout,
  menuSettingsRepository,
  nowIso,
  getHealthSnapshot,
  getRuntimeFeatureProfile,
  getRuntimeMetricsSnapshot,
  readJsonBody,
  resetRuntimeMetrics,
  resolveSettingsVersion,
  runtimeMetricsPeerTimeoutMs = 750,
  runtimeMetricsPeerUrls = [],
  runtimeMetricsServiceToken = "",
  sanitizePosSettings,
  sendJson,
}) {
  async function handleMonitorControl(req, res) {
    if (typeof readJsonBody !== "function") {
      throw createControlError(500, "Controlli monitor non configurati.");
    }
    const payload = await readJsonBody(req);
    sendJson(res, 200, await applyMonitorControl(payload, req));
  }

  async function handleHealth(_req, res) {
    let databaseHealth;
    try {
      databaseHealth =
        typeof checkPersistenceHealth === "function"
          ? await checkPersistenceHealth()
          : { ok: true, mode: "unknown" };
    } catch (error) {
      console.warn(
        `[health] Persistenza non raggiungibile: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      sendJson(res, 503, {
        ok: false,
        service: "cash-backend",
        version: "0.0.2",
        database: {
          ok: false,
        },
        environment: appEnv,
        timestamp: nowIso(),
      });
      return;
    }

    let postgresqlHealth = { enabled: false, ok: true, status: "disabled" };
    try {
      if (typeof checkPostgresqlHealth === "function") {
        postgresqlHealth = await checkPostgresqlHealth();
      }
    } catch (error) {
      console.warn("[health] PostgreSQL non raggiungibile.");
      postgresqlHealth = { enabled: true, ok: false, status: "unavailable" };
    }
    const publicPostgresqlHealth = postgresqlHealth?.enabled === true
      ? { enabled: true, ok: postgresqlHealth?.ok === true }
      : { enabled: false, ok: true };
    if (publicPostgresqlHealth.enabled && !publicPostgresqlHealth.ok) {
      sendJson(res, 503, {
        ok: false,
        service: "cash-backend",
        version: "0.0.2",
        database: {
          ok: databaseHealth?.ok === true,
          mode: databaseHealth?.mode ?? "unknown",
        },
        postgresql: publicPostgresqlHealth,
        environment: appEnv,
        timestamp: nowIso(),
      });
      return;
    }

    const settingsVersion = await resolveHealthSettingsVersion();
    sendJson(res, 200, {
      ok: true,
      service: "cash-backend",
      version: "0.0.2",
      database: {
        ok: databaseHealth?.ok === true,
        mode: databaseHealth?.mode ?? "unknown",
      },
      postgresql: publicPostgresqlHealth,
      settingsVersion,
      environment: appEnv,
      timestamp: nowIso(),
    });
  }

  async function handleOrderWorkflowSettings(_req, res) {
    sendJson(res, 200, await readOrderWorkflowSettingsView());
  }

  async function handlePaymentMethodsSettings(_req, res) {
    sendJson(res, 200, await readPaymentMethodsSettingsView());
  }

  async function handlePaymentTerminalsSettings(_req, res) {
    sendJson(res, 200, await readPaymentTerminalsSettingsView());
  }

	  async function handleMonitorOverview(_req, res) {
	    sendJson(res, 200, await readMonitorOverviewView());
	  }

  function buildLocalRuntimeMetricsSnapshot() {
    const snapshot =
      typeof getRuntimeMetricsSnapshot === "function"
        ? getRuntimeMetricsSnapshot()
        : { enabled: false };
    const memoryUsage =
      typeof process !== "undefined" && typeof process.memoryUsage === "function"
        ? process.memoryUsage()
        : {};
    const cpuUsage =
      typeof process !== "undefined" && typeof process.cpuUsage === "function"
        ? process.cpuUsage()
        : {};
    const userMicros = Math.max(0, Number(cpuUsage.user) || 0);
    const systemMicros = Math.max(0, Number(cpuUsage.system) || 0);
    return {
      ...snapshot,
      featureProfile:
        typeof getRuntimeFeatureProfile === "function" ? getRuntimeFeatureProfile() : null,
      process: {
        role: normalizeText(backendProcessRole) || "monolith",
        pid: typeof process !== "undefined" ? process.pid : null,
        sampledAtMs: Date.now(),
        uptimeSec:
          typeof process !== "undefined" && typeof process.uptime === "function"
            ? process.uptime()
            : null,
        memory: {
          rssBytes: Math.max(0, Number(memoryUsage.rss) || 0),
          heapTotalBytes: Math.max(0, Number(memoryUsage.heapTotal) || 0),
          heapUsedBytes: Math.max(0, Number(memoryUsage.heapUsed) || 0),
          externalBytes: Math.max(0, Number(memoryUsage.external) || 0),
        },
        cpu: {
          userMicros,
          systemMicros,
          totalMicros: userMicros + systemMicros,
        },
      },
    };
  }

  async function fetchRuntimeMetricsPeer(baseUrl, index) {
    const url = normalizeUrl(baseUrl);
    const startedAtMs = Date.now();
    if (!url) {
      return { ok: false, index, url, error: "URL worker vuoto.", durationMs: 0 };
    }
    if (!runtimeMetricsServiceToken || typeof fetchWithTimeout !== "function") {
      return { ok: false, index, url, error: "Service token o fetch non configurati.", durationMs: 0 };
    }
    try {
      const response = await fetchWithTimeout(`${url}/api/internal/monitor/runtime-metrics`, {
        headers: { "X-Service-Token": runtimeMetricsServiceToken },
        timeoutMs: runtimeMetricsPeerTimeoutMs,
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!response.ok || body?.ok !== true) {
        return {
          ok: false,
          index,
          url,
          status: response.status,
          error: body?.error || text.slice(0, 240) || `HTTP ${response.status}`,
          durationMs: Date.now() - startedAtMs,
        };
      }
      const runtimeMetrics = body.runtimeMetrics && typeof body.runtimeMetrics === "object"
        ? body.runtimeMetrics
        : { enabled: false };
      return {
        ok: true,
        index,
        url,
        status: response.status,
        role: normalizeText(runtimeMetrics?.process?.role),
        pid: runtimeMetrics?.process?.pid ?? null,
        generatedAtMs: Number(runtimeMetrics?.generatedAtMs) || 0,
        durationMs: Date.now() - startedAtMs,
        runtimeMetrics,
      };
    } catch (error) {
      return {
        ok: false,
        index,
        url,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAtMs,
      };
    }
  }

  async function buildRuntimeMetricsSnapshot({ includePeers = true } = {}) {
    const snapshot = buildLocalRuntimeMetricsSnapshot();
    const peerUrls = Array.isArray(runtimeMetricsPeerUrls)
      ? runtimeMetricsPeerUrls.map(normalizeUrl).filter(Boolean)
      : [];
    const shouldCollectPeers =
      includePeers === true &&
      !["api-worker", "table-lock-worker"].includes(normalizeText(backendProcessRole)) &&
      peerUrls.length > 0;
    if (!shouldCollectPeers) {
      return {
        ...snapshot,
        workerCollection: {
          enabled: false,
          expected: peerUrls.length,
          collected: 0,
          failed: 0,
        },
        workers: [],
      };
    }
    const workers = await Promise.all(peerUrls.map((url, index) => fetchRuntimeMetricsPeer(url, index)));
    const collected = workers.filter((worker) => worker.ok === true).length;
    return {
      ...snapshot,
      workerCollection: {
        enabled: true,
        expected: peerUrls.length,
        collected,
        failed: workers.length - collected,
      },
      workers,
    };
  }

  async function handleRuntimeMetrics(_req, res) {
    const snapshot = await buildRuntimeMetricsSnapshot({ includePeers: true });
    sendJson(res, 200, {
      ok: true,
      runtimeMetrics: snapshot,
    });
  }

  async function handleRuntimeMetricsInternal(_req, res) {
    const snapshot = await buildRuntimeMetricsSnapshot({ includePeers: false });
    sendJson(res, 200, {
      ok: true,
      runtimeMetrics: snapshot,
    });
  }

  async function handleRuntimeMetricsReset(_req, res) {
    if (typeof resetRuntimeMetrics === "function") {
      resetRuntimeMetrics();
    }
    const snapshot = await buildRuntimeMetricsSnapshot({ includePeers: true });
    sendJson(res, 200, {
      ok: true,
      reset: true,
      runtimeMetrics: snapshot,
    });
  }
	
  return {
    "health": handleHealth,
    "settings.orderWorkflow": handleOrderWorkflowSettings,
    "settings.paymentMethods": handlePaymentMethodsSettings,
    "settings.paymentTerminals": handlePaymentTerminalsSettings,
    "monitor.overview": handleMonitorOverview,
    "monitor.runtimeMetrics": handleRuntimeMetrics,
    "monitor.runtimeMetricsInternal": handleRuntimeMetricsInternal,
    "monitor.runtimeMetricsReset": handleRuntimeMetricsReset,
    "monitor.control": handleMonitorControl,
  };
}
