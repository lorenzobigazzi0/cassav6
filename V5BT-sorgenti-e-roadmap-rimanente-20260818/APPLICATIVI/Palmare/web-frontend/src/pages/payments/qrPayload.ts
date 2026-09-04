export function normalizeQrPayload(value: string): string {
  return value.trim();
}

export function isProbablyAutomaticCashQrPayload(value: string): boolean {
  const text = normalizeQrPayload(value);
  if (!text) return false;
  if (text.startsWith("FCA:")) return true;
  if (text.includes("cashFloatId")) return true;
  return text.length > 20;
}
