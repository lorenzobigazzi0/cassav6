import { apiFetch } from "./baseUrl";

export type TopSoldProduct = {
  rank: number;
  productId: string;
  name: string;
  category: string | null;
  quantity: number;
  revenue: number;
  lastSoldAt: string | null;
  source: "payments" | "orders_fallback" | string;
};

const normalizeText = (value: unknown) => String(value ?? "").trim();

const normalizeNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const normalizeTopSoldProduct = (entry: unknown): TopSoldProduct | null => {
  if (!entry || typeof entry !== "object") return null;
  const source = entry as Record<string, unknown>;
  const productId = normalizeText(source.productId);
  const name = normalizeText(source.name);
  if (!productId || !name) return null;
  return {
    rank: Math.max(Math.trunc(normalizeNumber(source.rank)), 1),
    productId,
    name,
    category: normalizeText(source.category) || null,
    quantity: Math.max(Math.trunc(normalizeNumber(source.quantity)), 0),
    revenue: Math.max(normalizeNumber(source.revenue), 0),
    lastSoldAt: normalizeText(source.lastSoldAt) || null,
    source: normalizeText(source.source) || "payments",
  };
};

export async function fetchTopSoldProducts(params: { days?: number; limit?: number } = {}) {
  const search = new URLSearchParams();
  search.set("days", String(params.days ?? 15));
  search.set("limit", String(params.limit ?? 10));
  const response = await apiFetch(`/api/integration/menu/top-sold?${search.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Top venduti non disponibili (${response.status}).`);
  }
  const payload = (await response.json()) as { items?: unknown };
  return (Array.isArray(payload.items) ? payload.items : [])
    .map(normalizeTopSoldProduct)
    .filter((entry): entry is TopSoldProduct => entry !== null)
    .slice(0, Math.max(Math.trunc(params.limit ?? 10), 1));
}
