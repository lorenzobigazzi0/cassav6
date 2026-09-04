import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api/baseUrl";
import { markAutomaticCashFloatTicketPrinted } from "../../api/automaticCash";
import { SETTLEMENT_PRINT_PATH } from "../../api/paymentSettlementEndpoints";
import type { CashFloatTicket, CashFloatTicketPrintAuth } from "./cashFloatTicket";

type CashFloatTicketModalProps = {
  ticket: CashFloatTicket | null;
  auth: CashFloatTicketPrintAuth;
  onClose: () => void;
  onInserted: () => void | Promise<void>;
  insertBusy?: boolean;
  insertError?: string;
};

type PrintResponse = {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  printer?: unknown;
};

async function printAutomaticCashFloatTicket(
  ticket: CashFloatTicket,
  auth: CashFloatTicketPrintAuth
) {
  const token = String(auth.token ?? "").trim();
  const userId = String(auth.userId ?? "").trim();
  const deviceUuid = String(auth.deviceUuid ?? "").trim();
  if (!token || !userId || !deviceUuid) {
    throw new Error("Sessione login richiesta per stampare lo scontrino.");
  }

  const response = await apiFetch(SETTLEMENT_PRINT_PATH, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Device-Uuid": deviceUuid,
      "X-User-Id": userId,
    },
    body: JSON.stringify({
      kind: "preconto",
      clientApp: "mobile-automatic-cash",
      token,
      userId,
      username: auth.username ?? "",
      fullName: auth.fullName ?? "",
      deviceUuid,
      ignoreWorkstationRouting: true,
      operationalSchemaVersion: 2,
      activityId: auth.activityId ?? "",
      roomId: auth.roomId ?? "",
      precontoProfile: "cash",
      text: ticket.printText,
    }),
  });

  const payload = (await response.json().catch(() => null)) as PrintResponse | null;
  if (!response.ok || payload?.ok === false) {
    const message = String(payload?.error ?? payload?.message ?? "").trim();
    throw new Error(message || "Stampa scontrino fondo cassa non riuscita.");
  }
  return String(payload?.printer ?? "").trim();
}

export function CashFloatTicketModal({
  ticket,
  auth,
  onClose,
  onInserted,
  insertBusy = false,
  insertError = "",
}: CashFloatTicketModalProps) {
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState("");
  const printedTicketId = useRef("");

  const printTicket = async () => {
    if (!ticket || printing) return;
    setPrinting(true);
    setMessage("");
    try {
      const printer = await printAutomaticCashFloatTicket(ticket, auth);
      if (ticket.workflowId) {
        await markAutomaticCashFloatTicketPrinted({
          workflowId: ticket.workflowId,
          cashFloatId: ticket.cashFloatId,
          printJobId: printer || undefined,
          printedAtMs: Date.now(),
        });
      }
      setMessage(printer ? `Scontrino inviato su ${printer}.` : "Scontrino inviato in stampa.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stampa non riuscita.");
    } finally {
      setPrinting(false);
    }
  };

  useEffect(() => {
    if (!ticket || printedTicketId.current === ticket.cashFloatId) return;
    if (ticket.autoPrint === false) return;
    printedTicketId.current = ticket.cashFloatId;
    void printTicket();
    // printTicket intentionally depends on transient state; only auto-print per ticket id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.cashFloatId]);

  if (!ticket) return null;

  return (
    <div className="payments-confirm-backdrop" onClick={onClose}>
      <div
        className="payments-confirm-card payments-ticket-card"
        role="dialog"
        aria-modal="true"
        aria-label="Scontrino fondo cassa automatico"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="payments-confirm-head">
          <strong>Scontrino fondo cassa</strong>
          <button
            type="button"
            className="smallbtn payments-confirm-close"
            onClick={onClose}
            aria-label="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="payments-confirm-body payments-ticket-body">
          {message && <div className="payments-note">{message}</div>}
          {insertError ? <div className="payments-alert is-error">{insertError}</div> : null}
        </div>

        <div className="payments-actions payments-auto-actions">
          <button
            type="button"
            className="smallbtn payments-auto-secondary"
            onClick={printTicket}
            disabled={printing}
          >
            {printing ? "Stampa..." : "Ristampa"}
          </button>
          <button
            type="button"
            className="smallbtn payments-confirm"
            onClick={() => void onInserted()}
            disabled={insertBusy}
          >
            {insertBusy ? "Conferma..." : "Scontrino nel borsellino"}
          </button>
        </div>
      </div>
    </div>
  );
}
