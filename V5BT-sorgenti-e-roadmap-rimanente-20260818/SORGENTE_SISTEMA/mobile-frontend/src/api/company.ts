import { apiFetch } from "./baseUrl";

export type CompanyLookupResult = {
  ragioneSociale: string;
  indirizzo: string;
  cap: string;
  citta: string;
  provincia: string;
  sdi: string;
  pec: string;
};

type CompanyLookupResponse = Partial<CompanyLookupResult> & {
  message?: string;
  error?: string;
};

export async function verifyCompanyByVat(piva: string): Promise<CompanyLookupResult> {
  const response = await apiFetch("/api/verifica", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ piva }),
  });

  let payload: CompanyLookupResponse | null = null;
  try {
    payload = (await response.json()) as CompanyLookupResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.message || payload?.error || "Errore durante la verifica della Partita IVA.";
    throw new Error(message);
  }

  return {
    ragioneSociale: payload?.ragioneSociale ?? "",
    indirizzo: payload?.indirizzo ?? "",
    cap: payload?.cap ?? "",
    citta: payload?.citta ?? "",
    provincia: payload?.provincia ?? "",
    sdi: payload?.sdi ?? "",
    pec: payload?.pec ?? "",
  };
}
