import { apiJson } from "./baseUrl";

export type PaymentTerminal = {
  id: string;
  label: string;
  enabled: boolean;
  provider?: string;
  protocol?: string;
  terminalId?: string;
  merchantId?: string;
  serialNumber?: string;
  ipAddress?: string;
  port?: string;
  workstationId?: string;
  notes?: string;
};

type PaymentTerminalsResponse = {
  ok?: boolean;
  paymentTerminals?: PaymentTerminal[];
};

export async function getPaymentTerminals(signal?: AbortSignal): Promise<PaymentTerminal[]> {
  const payload = await apiJson<PaymentTerminalsResponse>("/api/settings/payment-terminals", {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!Array.isArray(payload?.paymentTerminals)) return [];
  return payload.paymentTerminals
    .map((terminal) => ({
      ...terminal,
      id: String(terminal?.id ?? "").trim(),
      label: String(terminal?.label ?? "").trim(),
      enabled: terminal?.enabled !== false,
    }))
    .filter((terminal) => Boolean(terminal.id && terminal.label));
}
