import { sleep } from "../utils/sleep";

type InvoiceValidationInput = {
  vatNumber: string;
  pec: string;
};

export type InvoiceValidationResult = {
  ok: boolean;
  vatValid: boolean;
  pecValid: boolean;
  message: string;
};

const VAT_REGEX = /^\d{11}$/;
const PEC_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

const validateVatOnline = async (vatNumber: string) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(`https://api.vatcomply.com/vat?vat_number=IT${vatNumber}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { valid?: boolean };
    return Boolean(payload.valid);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

export async function validateInvoiceRecipient(
  input: InvoiceValidationInput
): Promise<InvoiceValidationResult> {
  await sleep(140);

  const vatNumber = input.vatNumber.trim();
  const pec = input.pec.trim();
  const vatLocalValid = VAT_REGEX.test(vatNumber);
  const pecValid = PEC_REGEX.test(pec);

  if (!vatLocalValid) {
    return {
      ok: false,
      vatValid: false,
      pecValid,
      message: "Partita IVA non valida (attesi 11 numeri).",
    };
  }

  if (!pecValid) {
    return {
      ok: false,
      vatValid: true,
      pecValid: false,
      message: "PEC non valida.",
    };
  }

  const onlineResult = await validateVatOnline(vatNumber);
  if (onlineResult === false) {
    return {
      ok: false,
      vatValid: false,
      pecValid: true,
      message: "Partita IVA non valida secondo verifica online.",
    };
  }

  if (onlineResult === null) {
    return {
      ok: true,
      vatValid: true,
      pecValid: true,
      message: "Verifica online non disponibile, validazione completata con controlli locali.",
    };
  }

  return {
    ok: true,
    vatValid: true,
    pecValid: true,
    message: "Partita IVA e PEC verificate.",
  };
}
