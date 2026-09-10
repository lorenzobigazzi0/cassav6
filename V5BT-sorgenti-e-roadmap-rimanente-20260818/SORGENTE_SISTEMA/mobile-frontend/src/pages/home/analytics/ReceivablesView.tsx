import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../api/baseUrl";
import { formatCurrency } from "../../../shared/format/currency";
import type { AnalyticsSessionContext } from "../../../api/analyticsPaymentMovements";

type Receivable = { id: string; orderId: string; type: "GOODS" | "SERVICES"; amount: number; originalAmount: number; operatorName: string; tableLabel: string; fiscal: boolean; createdAt: string | number | null; revision: number };

export function ReceivablesView({ session }: { session: AnalyticsSessionContext }) {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Receivable[]>([]);
  const [selected, setSelected] = useState<Receivable | null>(null);
  const [method, setMethod] = useState("cash");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/reports/receivables", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token || ""}`, "X-User-Id": session.userId || "", "X-Device-Uuid": session.deviceUuid || "" }, body: JSON.stringify(session) })
      .then(async (response) => { const body = await response.json(); if (!response.ok || body?.ok !== true) throw new Error(body?.error || "Non riscossi non disponibili."); setRows(Array.isArray(body.receivables) ? body.receivables : []); })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Non riscossi non disponibili."); });
    return () => controller.abort();
  }, [session]);
  const filtered = useMemo(() => { const q = search.trim().toLowerCase(); return !q ? rows : rows.filter((row) => `${row.id} ${row.orderId} ${row.operatorName} ${row.tableLabel} ${row.type}`.toLowerCase().includes(q)); }, [rows, search]);
  return <>
    <label className="analytics-search receivables-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/></svg><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca non riscosso, tavolo, operatore..."/></label>
    <div className="analytics-list receivables-list">{error ? <div className="analytics-empty is-error">{error}</div> : filtered.length === 0 ? <div className="analytics-empty">Nessun importo non riscosso.</div> : filtered.map((row) => <article key={row.id} className="analytics-row mobile-analytics-payment-row-native receivable-row" role="button" tabIndex={0} onClick={() => setSelected(row)}><div className="analytics-row-top"><span className="analytics-kind-pill receivable-pill">{row.type === "GOODS" ? "BENI" : "SERVIZI"}</span><span className="analytics-time">{row.fiscal ? "FISCALE" : "NON FISCALE"}</span></div><div className="analytics-row-main"><strong>{formatCurrency(row.amount)}</strong><span>{row.tableLabel || row.operatorName || row.orderId}</span></div></article>)}</div>
    {selected ? <div className="mobile-analytics-detail-backdrop" onPointerDown={() => setSelected(null)}><section className="mobile-analytics-detail-modal" role="dialog" aria-modal="true" onPointerDown={(event) => event.stopPropagation()}><header className="mobile-analytics-detail-head"><div><strong>DETTAGLIO NON RISCOSSO</strong></div><button type="button" className="smallbtn mobile-analytics-detail-close" onClick={() => setSelected(null)}>X</button></header><div className="mobile-analytics-detail-body"><div className="mobile-analytics-detail-line"><span>Importo</span><strong>{formatCurrency(selected.amount)}</strong></div><div className="mobile-analytics-detail-line"><span>Tipo</span><strong>{selected.type === "GOODS" ? "BENI" : "SERVIZI"}</strong></div><div className="mobile-analytics-detail-line"><span>Documento</span><strong>{selected.fiscal ? "FISCALE" : "NON FISCALE"}</strong></div><label className="receivable-method-picker"><span>METODO DI PAGAMENTO</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">CONTANTI</option><option value="card">CARTA / POS</option><option value="check">ASSEGNO</option></select></label><div className="receivable-safety-note">La conferma sarà disponibile quando il servizio transazionale Receivable/FiscalOperation è attivo.</div></div></section></div> : null}
  </>;
}
