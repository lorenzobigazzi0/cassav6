export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function attr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

export function formatMoney(cents, currency = "EUR") {
  const amount = Number(cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function uid(prefix = "id") {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random.slice(0, 12)}`;
}

export function slugId(value, prefix = "id") {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return normalized || uid(prefix);
}

export function badge(label, tone = "neutral") {
  return `<span class="badge badge--${attr(tone)}">${escapeHtml(label)}</span>`;
}

export function emptyState(title, description, action = "") {
  return `<div class="empty-state"><div class="empty-state__icon">◇</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${action}</div>`;
}

export function pageHeader(title, description, actions = "") {
  return `<div class="page-heading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><div class="page-heading__actions">${actions}</div></div>`;
}

export function inputField({ label, name, value = "", type = "text", min = "", max = "", step = "", required = false, help = "", placeholder = "" }) {
  return `<label class="field"><span>${escapeHtml(label)}${required ? " *" : ""}</span><input name="${attr(name)}" type="${attr(type)}" value="${attr(value)}" ${min !== "" ? `min="${attr(min)}"` : ""} ${max !== "" ? `max="${attr(max)}"` : ""} ${step !== "" ? `step="${attr(step)}"` : ""} ${required ? "required" : ""} placeholder="${attr(placeholder)}" />${help ? `<small>${escapeHtml(help)}</small>` : ""}</label>`;
}

export function selectField({ label, name, value = "", options = [], required = false, help = "" }) {
  const html = options.map((option) => {
    const item = typeof option === "string" ? { value: option, label: option } : option;
    return `<option value="${attr(item.value)}" ${String(item.value) === String(value) ? "selected" : ""}>${escapeHtml(item.label)}</option>`;
  }).join("");
  return `<label class="field"><span>${escapeHtml(label)}${required ? " *" : ""}</span><select name="${attr(name)}" ${required ? "required" : ""}>${html}</select>${help ? `<small>${escapeHtml(help)}</small>` : ""}</label>`;
}

export function textareaField({ label, name, value = "", rows = 4, help = "" }) {
  return `<label class="field field--wide"><span>${escapeHtml(label)}</span><textarea name="${attr(name)}" rows="${Number(rows) || 4}">${escapeHtml(value)}</textarea>${help ? `<small>${escapeHtml(help)}</small>` : ""}</label>`;
}

export function checkboxField({ label, name, checked = false, help = "" }) {
  return `<label class="check-field"><input name="${attr(name)}" type="checkbox" ${checked ? "checked" : ""} /><span><strong>${escapeHtml(label)}</strong>${help ? `<small>${escapeHtml(help)}</small>` : ""}</span></label>`;
}

export function actionButton(label, action, options = {}) {
  const tone = options.tone ?? "secondary";
  return `<button type="button" class="button button--${attr(tone)} ${options.compact ? "button--compact" : ""}" data-action="${attr(action)}" ${options.id ? `data-id="${attr(options.id)}"` : ""} ${options.context ? `data-context="${attr(options.context)}"` : ""} ${options.disabled ? "disabled" : ""}>${escapeHtml(label)}</button>`;
}

export function metricCard(label, value, hint = "", tone = "neutral") {
  return `<article class="metric-card metric-card--${attr(tone)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</article>`;
}

export function issueList(validation) {
  if (!validation) return `<p class="muted">La bozza non è ancora stata validata.</p>`;
  const errors = validation.errors ?? [];
  const warnings = validation.warnings ?? [];
  if (!errors.length && !warnings.length) return `<div class="callout callout--success"><strong>Configurazione valida.</strong><span>Nessun errore o avviso rilevato.</span></div>`;
  return `<div class="issue-groups">${errors.length ? `<section><h4>Errori bloccanti (${errors.length})</h4>${errors.map((item) => `<div class="issue issue--error"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span><code>${escapeHtml(item.path || "configurazione")}</code></div>`).join("")}</section>` : ""}${warnings.length ? `<section><h4>Avvisi (${warnings.length})</h4>${warnings.map((item) => `<div class="issue issue--warning"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span><code>${escapeHtml(item.path || "configurazione")}</code></div>`).join("")}</section>` : ""}</div>`;
}

export const WEEKDAYS = [
  ["mon", "Lun"], ["tue", "Mar"], ["wed", "Mer"], ["thu", "Gio"],
  ["fri", "Ven"], ["sat", "Sab"], ["sun", "Dom"],
];

export function minutesToTime(value) {
  const minutes = Math.max(0, Math.min(1440, Number(value) || 0));
  if (minutes === 1440) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function timeToMinutes(value, fallback = 0) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  return Math.max(0, Math.min(1440, Number(match[1]) * 60 + Number(match[2])));
}
