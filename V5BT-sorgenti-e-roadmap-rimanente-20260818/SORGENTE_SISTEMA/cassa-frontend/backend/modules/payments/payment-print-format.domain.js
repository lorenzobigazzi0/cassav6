export function createPaymentPrintFormatHelpers(options = {}) {
  const {
    normalizePaymentMethodType = (value) => String(value ?? "").trim().toUpperCase(),
    normalizeStringList = (value) => (Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : []),
    roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100,
    nowMs = () => Date.now(),
  } = options;

  function formatIntegrationPrintDateTime(value) {
    const parsed = Number(value);
    const date = new Date(Number.isFinite(parsed) && parsed > 0 ? parsed : nowMs());
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${year}-${hours}:${minutes}`;
  }

  function formatIntegrationPrintOrderId(value) {
    const raw = String(value ?? "").trim();
    const digits = raw.replace(/\D/g, "");
    if (digits) {
      const normalized = digits.replace(/^0+/, "") || "0";
      return `#${normalized}`;
    }
    return raw ? `#${raw}` : "#-";
  }

  function formatIntegrationPrintDisplayName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        if (/^\d+$/.test(part)) return part;
        return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      })
      .join(" ");
  }

  function isElectronicPaymentReceiptMethod(methodType, methodId = "", methodLabel = "") {
    const normalizedType = normalizePaymentMethodType(methodType);
    if (normalizedType === "CASH") return true;
    if (normalizedType === "POS") return true;
    const id = String(methodId ?? "").trim().toLowerCase();
    const label = String(methodLabel ?? "").trim().toLowerCase();
    return (
      id.includes("cash") ||
      id.includes("contant") ||
      id.includes("chip") ||
      id.includes("smart") ||
      id.includes("card") ||
      id.includes("pos") ||
      label.includes("contant") ||
      label.includes("cash") ||
      label.includes("myconto") ||
      label.includes("smart") ||
      label.includes("carta") ||
      label.includes("pos")
    );
  }

  function buildMobilePaymentOrderReferenceLabel(allBills = [], selectedBillIds = [], fallbackOrderId = "") {
    const safeBills = Array.isArray(allBills) ? allBills : [];
    const uniqueBillIds = [...new Set(
      (Array.isArray(selectedBillIds) ? selectedBillIds : [])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    )];
    const matchedBills = uniqueBillIds.length
      ? safeBills.filter((bill) => uniqueBillIds.includes(String(bill?.id ?? "").trim()))
      : safeBills;
    const explicitReferences = matchedBills
      .flatMap((bill) => {
        const directOrderId = String(bill?.orderId ?? bill?.integrationOrderId ?? "").trim();
        const arrayOrderIds = Array.isArray(bill?.orderIds)
          ? bill.orderIds
          : Array.isArray(bill?.integrationOrderIds)
            ? bill.integrationOrderIds
            : [];
        return [directOrderId, ...arrayOrderIds];
      })
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry && !/^bill_/i.test(entry))
      .map((entry) => formatIntegrationPrintOrderId(entry))
      .filter(Boolean);
    const orderReferences = [...new Set(explicitReferences)];
    if (orderReferences.length === 1) {
      return `COMANDA ${orderReferences[0]}`;
    }
    if (orderReferences.length > 1 && orderReferences.length <= 3) {
      return `COMANDE ${orderReferences.join(", ")}`;
    }
    if (orderReferences.length > 1) {
      return `${orderReferences.length} COMANDE`;
    }
    const fallbackRaw = String(fallbackOrderId ?? "").trim();
    if (fallbackRaw && !/^bill_/i.test(fallbackRaw)) {
      return `COMANDA ${formatIntegrationPrintOrderId(fallbackRaw)}`;
    }
    if (matchedBills.length > 1) {
      return `${matchedBills.length} COMANDE`;
    }
    if (matchedBills.length === 1) {
      return "COMANDA #-";
    }
    if (uniqueBillIds.length > 1) {
      return `${uniqueBillIds.length} COMANDE`;
    }
    if (safeBills.length > 1) {
      return `${safeBills.length} COMANDE`;
    }
    if (safeBills.length === 1 || uniqueBillIds.length === 1) {
      return "COMANDA #-";
    }
    return "COMANDA #-";
  }

  function normalizePaymentPrintNote(value) {
    const lines = String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.join("\n").slice(0, 240).trim();
  }

  function formatPaymentMethodPrintLabel(value) {
    const method = normalizePaymentMethodType(value);
    if (method === "CASH") return "CONTANTI";
    if (method === "POS") return "CARTA/POS";
    if (method === "MIXED") return "MISTO";
    return "ALTRO";
  }

  function formatRefundActionPrintLabel(value) {
    const action = String(value ?? "").trim().toLowerCase();
    if (action === "cash_refund") return "RIMBORSO CONTANTI";
    if (action === "pos_void_full_transaction") return "STORNO TOTALE POS";
    if (action === "pos_void_full_transaction_and_recharge_remaining") {
      return "STORNO TOTALE POS + RIADDEBITO";
    }
    if (action === "manual_mixed_refund") return "RIMBORSO MANUALE MISTO";
    if (action === "manual_refund") return "RIMBORSO MANUALE";
    return action ? action.replace(/_/g, " ").toUpperCase() : "DA GESTIRE";
  }

  function normalizeStornoPaymentReferences(value) {
    const source = Array.isArray(value) ? value : [];
    return source
      .map((entry) => {
        const transactions = Array.isArray(entry?.transactions) ? entry.transactions : [];
        const explicitTransactionIds = normalizeStringList(entry?.transactionIds, 20, 120);
        const transactionIds = [
          ...new Set([
            ...explicitTransactionIds,
            ...transactions.map((tx) => String(tx?.transactionId ?? tx?.id ?? "").trim()).filter(Boolean),
          ]),
        ];
        return {
          paymentId: String(entry?.paymentId ?? entry?.id ?? "").trim(),
          method: normalizePaymentMethodType(entry?.method ?? entry?.paymentMethod),
          action: String(entry?.action ?? "").trim(),
          refundAmount: roundMoney(Math.max(Number(entry?.refundAmount ?? entry?.amount) || 0, 0)),
          voidAmount: roundMoney(Math.max(Number(entry?.voidAmount) || 0, 0)),
          rechargeAmount: roundMoney(Math.max(Number(entry?.rechargeAmount) || 0, 0)),
          transactionIds,
          fiscalDocType: String(entry?.fiscalDocType ?? "").trim(),
          fiscalDocNo: String(entry?.fiscalDocNo ?? "").trim(),
        };
      })
      .filter((entry) => entry.paymentId || entry.transactionIds.length > 0 || entry.refundAmount > 0);
  }

  return {
    buildMobilePaymentOrderReferenceLabel,
    formatIntegrationPrintDateTime,
    formatIntegrationPrintDisplayName,
    formatIntegrationPrintOrderId,
    formatPaymentMethodPrintLabel,
    formatRefundActionPrintLabel,
    isElectronicPaymentReceiptMethod,
    normalizePaymentPrintNote,
    normalizeStornoPaymentReferences,
  };
}
