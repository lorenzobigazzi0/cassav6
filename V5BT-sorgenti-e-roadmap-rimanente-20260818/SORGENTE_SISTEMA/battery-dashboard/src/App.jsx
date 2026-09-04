import {
  Battery,
  BatteryCharging,
  Clock3,
  Hash,
  MonitorSmartphone,
  PlugZap,
  RefreshCw,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

const DASHBOARD_FALLBACK_REFRESH_MS = 30000;

const DATE_FORMAT = new Intl.DateTimeFormat("it-IT", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

function levelTone(level) {
  if (typeof level !== "number") return "unknown";
  if (level <= 20) return "critical";
  if (level <= 50) return "warning";
  return "good";
}

function shortId(value) {
  const text = String(value || "").trim();
  if (!text) return "N/D";
  if (text.length <= 22) return text;
  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

function formatTime(value) {
  if (!value) return "Mai";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/D";
  return DATE_FORMAT.format(date);
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "N/D";
  if (seconds < 60) return `${seconds}s fa`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m fa`;
  return `${Math.floor(minutes / 60)}h fa`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "N/D";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const remainingSeconds = value % 60;
  if (remainingSeconds === 0) return `${minutes} min`;
  return `${minutes}m ${remainingSeconds}s`;
}

function StatCard({ label, value, icon: Icon, tone = "neutral" }) {
  return (
    <section className={`stat-card tone-${tone}`}>
      <div className="stat-icon" aria-hidden="true">
        <Icon size={21} />
      </div>
      <div className="stat-copy">
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </section>
  );
}

function DeviceCard({ device }) {
  const tone = levelTone(device.level);
  const level = typeof device.level === "number" ? device.level : 0;

  return (
    <article className={`device-card battery-${tone} ${device.online ? "" : "is-offline"}`}>
      <div className="device-head">
        <div className="device-title">
          <span className="device-avatar">
            <MonitorSmartphone size={22} />
          </span>
          <div className="device-name">
            <h2>{device.device || "Android"}</h2>
            <p>{device.client_ip || "N/D"}</p>
          </div>
        </div>
        <span className={`status-pill ${device.online ? "online" : "offline"}`}>
          {device.online ? <Wifi size={15} /> : <WifiOff size={15} />}
          {device.online ? "Online" : "Offline"}
        </span>
      </div>

      <div className="battery-row">
        <div className="battery-main">
          <span className="metric-label">Batteria</span>
          <div className="battery-value">
            {typeof device.level === "number" ? `${device.level}%` : "N/D"}
          </div>
        </div>
        <div className={`charge-state ${device.charging ? "charging" : ""}`}>
          {device.charging ? <BatteryCharging size={18} /> : <Battery size={18} />}
          {device.charging ? "In carica" : "Non in carica"}
        </div>
      </div>

      <div className="battery-track" aria-label={`Batteria ${level}%`}>
        <span style={{ width: `${level}%` }} />
      </div>

      <dl className="device-meta">
        <div className="meta-item meta-id">
          <dt>
            <Hash size={14} />
            ID
          </dt>
          <dd title={device.device_id}>{shortId(device.device_id)}</dd>
        </div>
        <div className="meta-item">
          <dt>
            <Clock3 size={14} />
            Ultimo
          </dt>
          <dd>
            {formatTime(device.last_update)} <span>{formatAge(device.age_seconds)}</span>
          </dd>
        </div>
        <div className="meta-item">
          <dt>
            <Server size={14} />
            Invii
          </dt>
          <dd>{device.received_count || 0}</dd>
        </div>
      </dl>
    </article>
  );
}

function EventLog({ events }) {
  return (
    <section className="event-panel">
      <div className="panel-head">
        <h2>Eventi</h2>
        <span>{events.length}</span>
      </div>
      <div className="event-list">
        {events.length === 0 ? (
          <p className="empty-small">Nessun evento ricevuto</p>
        ) : (
          events.slice(0, 80).map((event) => (
            <div className="event-line" key={`${event.time}-${event.message}`}>
              <time>{formatTime(event.time)}</time>
              <span>{event.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastFetch, setLastFetch] = useState(null);

  const loadBattery = useCallback(async () => {
    try {
      const response = await fetch("/api/battery", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      setData(payload);
      setError("");
      setLastFetch(new Date());
    } catch (err) {
      setError(err.message || "Errore rete");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let fallbackTimer = null;

    const refreshSnapshot = () => {
      if (!disposed) void loadBattery();
    };

    const stopFallback = () => {
      if (fallbackTimer === null) return;
      window.clearInterval(fallbackTimer);
      fallbackTimer = null;
    };

    const startFallback = () => {
      if (fallbackTimer !== null) return;
      fallbackTimer = window.setInterval(refreshSnapshot, DASHBOARD_FALLBACK_REFRESH_MS);
    };

    refreshSnapshot();

    if (typeof window.EventSource !== "function") {
      startFallback();
      return () => {
        disposed = true;
        stopFallback();
      };
    }

    const source = new window.EventSource("/api/battery/events");
    const handleStreamUpdate = () => {
      stopFallback();
      refreshSnapshot();
    };

    source.addEventListener("open", stopFallback);
    source.addEventListener("ready", handleStreamUpdate);
    source.addEventListener("battery", handleStreamUpdate);
    source.onerror = () => {
      startFallback();
    };

    return () => {
      disposed = true;
      stopFallback();
      source.removeEventListener("open", stopFallback);
      source.removeEventListener("ready", handleStreamUpdate);
      source.removeEventListener("battery", handleStreamUpdate);
      source.close();
    };
  }, [loadBattery]);

  const devices = data?.devices || [];
  const averageLabel = typeof data?.average_level === "number" ? `${data.average_level}%` : "N/D";
  const lowBatteryCount = useMemo(
    () => devices.filter((device) => typeof device.level === "number" && device.level <= 20).length,
    [devices]
  );
  const offlineAfterLabel = formatDuration(data?.offline_after_seconds ?? 180);
  const removeAfterLabel = formatDuration(data?.remove_after_seconds ?? 360);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <span className="eyebrow">
            <ShieldCheck size={16} />
            Kiosk battery monitor
          </span>
          <h1>Monitor batterie Android</h1>
        </div>
        <button className="refresh-button" onClick={loadBattery} title="Aggiorna ora">
          <RefreshCw size={18} />
          Aggiorna
        </button>
      </header>

      <section className="endpoint-strip">
        <div className="endpoint-main">
          <span>Endpoint</span>
          <strong>{data?.endpoint || "http://IP:8765/battery"}</strong>
        </div>
        <div className="endpoint-refresh">
          <span>Refresh</span>
          <strong>{lastFetch ? formatTime(lastFetch) : loading ? "Carico" : "N/D"}</strong>
        </div>
      </section>

      {error ? <div className="alert">Connessione dashboard: {error}</div> : null}

      <section className="stats-grid">
        <StatCard label="Device" value={data?.device_count ?? 0} icon={MonitorSmartphone} />
        <StatCard label="Online" value={data?.online_count ?? 0} icon={Wifi} tone="good" />
        <StatCard label="Offline" value={data?.offline_count ?? 0} icon={WifiOff} tone="danger" />
        <StatCard label="In carica" value={data?.charging_count ?? 0} icon={PlugZap} tone="accent" />
        <StatCard label="Media" value={averageLabel} icon={Battery} tone="neutral" />
        <StatCard label="Critici" value={lowBatteryCount} icon={BatteryCharging} tone="warning" />
      </section>

      <div className="content-grid">
        <section className="devices-panel">
          <div className="panel-head">
            <h2>Device attivi</h2>
            <span>Offline {offlineAfterLabel} | rimuove {removeAfterLabel}</span>
          </div>
          {devices.length === 0 ? (
            <div className="empty-state">
              <MonitorSmartphone size={36} />
              <p>Nessun device ricevuto</p>
            </div>
          ) : (
            <div className="device-grid">
              {devices.map((device) => (
                <DeviceCard key={device.device_id} device={device} />
              ))}
            </div>
          )}
        </section>

        <EventLog events={data?.events || []} />
      </div>
    </main>
  );
}
