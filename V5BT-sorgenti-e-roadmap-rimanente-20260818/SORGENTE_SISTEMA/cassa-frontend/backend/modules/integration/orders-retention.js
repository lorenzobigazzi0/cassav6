/**
 * Retention delle comande nello stato applicativo.
 *
 * Le comande restano in `integration.orders` per sempre: ogni mutazione paga il costo
 * dell'insieme, e la latenza cresce con il servizio. Qui si sceglie quali comande sono
 * archiviabili, cioe concluse da abbastanza tempo da non servire piu operativamente.
 *
 * Nessuna comanda viene mai cancellata: chi usa questo modulo deve prima copiare le
 * righe scelte nella tabella di archivio e solo dopo rimuoverle dallo stato caldo.
 */

const TERMINAL_WORKFLOW = new Set(["delivered", "cancelled", "annullata", "voided"]);
const SETTLED_PAYMENT = new Set(["paid", "pagata"]);

function normalizedText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function orderTimestampMs(order) {
  const candidates = [
    order?.completedAtMs,
    order?.updatedAtMs,
    Date.parse(String(order?.updatedAt ?? "")),
    Date.parse(String(order?.createdAt ?? "")),
    order?.createdAtMs,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  }
  return 0;
}

/**
 * Una comanda e archiviabile solo se ha concluso sia il flusso operativo sia quello
 * economico: consegnata e pagata, oppure annullata. Una comanda annullata puo restare
 * non pagata, ma una consegnata con importo residuo resta viva a ogni costo, perche
 * rappresenta denaro ancora da incassare.
 */
export function isArchivableIntegrationOrder(order) {
  const workflow = normalizedText(order?.workflowStatus);
  if (!TERMINAL_WORKFLOW.has(workflow)) return false;
  const cancelled = workflow !== "delivered";
  if (cancelled) return true;
  if (!SETTLED_PAYMENT.has(normalizedText(order?.paymentStatus))) return false;
  return Math.max(0, Number(order?.dueAmount) || 0) <= 0.009;
}

/**
 * Divide le comande fra quelle da tenere calde e quelle archiviabili.
 *
 * `nowMs` e iniettato per rendere deterministici i test; `retentionMs` e la finestra
 * entro cui una comanda conclusa resta comunque disponibile, e `limit` limita quanto
 * lavoro fa un singolo giro di retention.
 */
export function selectArchivableIntegrationOrders(orders, options = {}) {
  const safeOrders = Array.isArray(orders) ? orders : [];
  const nowMs = Number(options.nowMs) || Date.now();
  const retentionMs = Math.max(0, Number(options.retentionMs) || 0);
  const limit = Math.max(0, Math.trunc(Number(options.limit) || 0));
  const cutoffMs = nowMs - retentionMs;

  const archivable = [];
  const retained = [];
  for (const order of safeOrders) {
    const id = String(order?.id ?? "").trim();
    const timestampMs = orderTimestampMs(order);
    const eligible =
      id.length > 0 &&
      isArchivableIntegrationOrder(order) &&
      // Senza data attendibile non si archivia: meglio tenere una comanda in piu
      // che rimuoverne una che potrebbe essere appena stata chiusa.
      timestampMs > 0 &&
      timestampMs <= cutoffMs;
    if (eligible && (limit === 0 || archivable.length < limit)) archivable.push(order);
    else retained.push(order);
  }
  return {
    archivable,
    retained,
    archivableIds: archivable.map((order) => String(order.id).trim()),
    cutoffMs,
  };
}

export function summarizeIntegrationOrdersRetention(selection, options = {}) {
  const archivable = Array.isArray(selection?.archivable) ? selection.archivable : [];
  const retained = Array.isArray(selection?.retained) ? selection.retained : [];
  return {
    scanned: archivable.length + retained.length,
    archived: archivable.length,
    retained: retained.length,
    cutoffMs: Number(selection?.cutoffMs) || 0,
    retentionHours: Math.max(0, Number(options.retentionHours) || 0),
    reason: String(options.reason ?? "scheduled"),
  };
}
