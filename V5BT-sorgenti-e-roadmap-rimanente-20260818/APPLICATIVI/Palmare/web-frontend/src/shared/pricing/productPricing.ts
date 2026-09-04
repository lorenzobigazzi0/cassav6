export type ProductTimedPriceRange = {
  id?: string;
  label?: string;
  price?: number;
  activePrice?: number;
  currentPrice?: number;
  startsAt?: string;
  endsAt?: string;
  startTime?: string;
  endTime?: string;
  daysOfWeek?: number[];
  active?: boolean;
};

export type ProductPricingSource =
  | "activePrice"
  | "currentPrice"
  | "price"
  | "basePrice"
  | "fallback";

export type ProductDisplayPricing = {
  displayPrice: number;
  basePrice: number;
  activeScheduleLabel?: string;
  nextPriceChangeAt?: string;
  hasTimedPricing: boolean;
  isFrontendEstimate: boolean;
  pricingSource: ProductPricingSource;
};

export type ProductClientPriceSnapshot = ProductDisplayPricing & {
  capturedAt: string;
};

export type ProductPricingMeta = Record<string, unknown>;

export type ProductPricingInput = {
  price?: unknown;
  basePrice?: unknown;
  priceSchedule?: unknown;
  timedPrices?: unknown;
  timePriceSchedule?: unknown;
  listinoTemporizzato?: unknown;
  activePrice?: unknown;
  currentPrice?: unknown;
  nextPriceChangeAt?: unknown;
  pricingLabel?: unknown;
  pricingSource?: unknown;
  pricingMeta?: unknown;
};

const MONEY_DECIMALS = 100;
const REFRESH_BUFFER_MS = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const roundMoney = (value: number) => Math.round(value * MONEY_DECIMALS) / MONEY_DECIMALS;

export const parseOptionalMoney = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? roundMoney(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? roundMoney(parsed) : undefined;
};

const readText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
};

const readValidDateIso = (value: unknown): string | undefined => {
  const raw =
    typeof value === "string" || typeof value === "number" || value instanceof Date
      ? value
      : undefined;
  if (raw === undefined || raw === "") return undefined;
  const timestamp = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
};

const readDaysOfWeek = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const days = value
    .map((entry) => Math.trunc(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6);
  return days.length ? [...new Set(days)] : undefined;
};

const scheduleArrayFromUnknown = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const directRanges = value.ranges ?? value.items ?? value.slots ?? value.schedule;
  return Array.isArray(directRanges) ? directRanges : [];
};

export const parseTimedPriceSchedule = (value: unknown): ProductTimedPriceRange[] => {
  return scheduleArrayFromUnknown(value)
    .filter(isRecord)
    .map((entry) => {
      const label = readText(entry.label ?? entry.name ?? entry.title);
      const price = parseOptionalMoney(entry.price ?? entry.amount ?? entry.value);
      const activePrice = parseOptionalMoney(entry.activePrice);
      const currentPrice = parseOptionalMoney(entry.currentPrice);
      const startsAt = readValidDateIso(entry.startsAt ?? entry.startAt ?? entry.from);
      const endsAt = readValidDateIso(entry.endsAt ?? entry.endAt ?? entry.to);
      const startTime = readText(entry.startTime ?? entry.fromTime);
      const endTime = readText(entry.endTime ?? entry.toTime);
      const daysOfWeek = readDaysOfWeek(entry.daysOfWeek ?? entry.weekDays);
      const range: ProductTimedPriceRange = {
        id: readText(entry.id),
        label,
        price,
        activePrice,
        currentPrice,
        startsAt,
        endsAt,
        startTime,
        endTime,
        daysOfWeek,
        active: entry.active === true,
      };
      return Object.fromEntries(
        Object.entries(range).filter(([, itemValue]) => itemValue !== undefined)
      ) as ProductTimedPriceRange;
    })
    .filter((entry) =>
      Boolean(
        entry.label ||
        entry.price !== undefined ||
        entry.activePrice !== undefined ||
        entry.currentPrice !== undefined ||
        entry.startsAt ||
        entry.endsAt ||
        entry.startTime ||
        entry.endTime ||
        entry.daysOfWeek?.length
      )
    );
};

const getPricingMeta = (input: ProductPricingInput) =>
  isRecord(input.pricingMeta) ? input.pricingMeta : {};

const getSchedules = (input: ProductPricingInput) => {
  const meta = getPricingMeta(input);
  return [
    ...parseTimedPriceSchedule(input.priceSchedule ?? meta.priceSchedule),
    ...parseTimedPriceSchedule(input.timedPrices ?? meta.timedPrices),
    ...parseTimedPriceSchedule(input.timePriceSchedule ?? meta.timePriceSchedule),
    ...parseTimedPriceSchedule(input.listinoTemporizzato ?? meta.listinoTemporizzato),
  ];
};

const sourceLooksTimed = (value: unknown) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return Boolean(
    normalized &&
    (normalized.includes("time") ||
      normalized.includes("schedule") ||
      normalized.includes("listino") ||
      normalized.includes("hour") ||
      normalized.includes("fascia"))
  );
};

const getExplicitScheduleLabel = (
  input: ProductPricingInput,
  schedules: ProductTimedPriceRange[]
) => {
  const meta = getPricingMeta(input);
  return (
    readText(input.pricingLabel) ??
    readText(meta.pricingLabel ?? meta.label ?? meta.activeScheduleLabel) ??
    schedules.find((entry) => entry.active && entry.label)?.label
  );
};

export function normalizeProductPricing(
  input: ProductPricingInput,
  options: { fallbackPrice?: number; now?: number } = {}
): ProductDisplayPricing {
  const meta = getPricingMeta(input);
  const schedules = getSchedules(input);
  const activePrice = parseOptionalMoney(input.activePrice ?? meta.activePrice);
  const currentPrice = parseOptionalMoney(input.currentPrice ?? meta.currentPrice);
  const price = parseOptionalMoney(input.price);
  const basePrice = parseOptionalMoney(input.basePrice ?? meta.basePrice);
  const fallbackPrice =
    parseOptionalMoney(options.fallbackPrice) ?? parseOptionalMoney(meta.fallbackPrice) ?? 0;

  const display =
    activePrice !== undefined
      ? { value: activePrice, source: "activePrice" as const }
      : currentPrice !== undefined
        ? { value: currentPrice, source: "currentPrice" as const }
        : price !== undefined
          ? { value: price, source: "price" as const }
          : basePrice !== undefined
            ? { value: basePrice, source: "basePrice" as const }
            : { value: fallbackPrice, source: "fallback" as const };

  const nextPriceChangeAt = readValidDateIso(input.nextPriceChangeAt ?? meta.nextPriceChangeAt);
  const explicitLabel = getExplicitScheduleLabel(input, schedules);
  const hasTimedPricing = Boolean(
    schedules.length > 0 ||
    explicitLabel ||
    nextPriceChangeAt ||
    activePrice !== undefined ||
    currentPrice !== undefined ||
    sourceLooksTimed(input.pricingSource ?? meta.pricingSource)
  );

  return {
    displayPrice: display.value,
    basePrice: basePrice ?? price ?? display.value,
    activeScheduleLabel: explicitLabel,
    nextPriceChangeAt,
    hasTimedPricing,
    isFrontendEstimate: display.source !== "activePrice" && display.source !== "currentPrice",
    pricingSource: display.source,
  };
}

export const getProductDisplayPricing = normalizeProductPricing;

export function getTimedPricingBadgeLabel(pricing: ProductDisplayPricing): string | undefined {
  if (!pricing.hasTimedPricing) return undefined;
  return pricing.activeScheduleLabel ?? "Listino ora";
}

export function formatNextPriceChangeLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return `Cambio prezzo alle ${new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp)}`;
}

export function createClientPriceSnapshot(
  input: ProductPricingInput,
  now = Date.now()
): ProductClientPriceSnapshot {
  return {
    ...normalizeProductPricing(input, { now }),
    capturedAt: new Date(now).toISOString(),
  };
}

export function normalizeClientPriceSnapshot(
  value: unknown
): ProductClientPriceSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const displayPrice = parseOptionalMoney(value.displayPrice);
  if (displayPrice === undefined) return undefined;
  const basePrice = parseOptionalMoney(value.basePrice) ?? displayPrice;
  const pricingSourceRaw = String(value.pricingSource ?? "").trim();
  const pricingSource: ProductPricingSource =
    pricingSourceRaw === "activePrice" ||
    pricingSourceRaw === "currentPrice" ||
    pricingSourceRaw === "price" ||
    pricingSourceRaw === "basePrice" ||
    pricingSourceRaw === "fallback"
      ? pricingSourceRaw
      : "fallback";
  return {
    displayPrice,
    basePrice,
    activeScheduleLabel: readText(value.activeScheduleLabel),
    nextPriceChangeAt: readValidDateIso(value.nextPriceChangeAt),
    hasTimedPricing: value.hasTimedPricing === true,
    isFrontendEstimate: value.isFrontendEstimate !== false,
    pricingSource,
    capturedAt: readValidDateIso(value.capturedAt) ?? new Date(0).toISOString(),
  };
}

export function getNextProductPriceChangeAt(
  products: ProductPricingInput[],
  now = Date.now()
): number | null {
  const next = products
    .map((product) => normalizeProductPricing(product).nextPriceChangeAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
    .sort((left, right) => left - right)[0];
  return next ?? null;
}

export function getTimedPricingRefreshDelay(
  products: ProductPricingInput[],
  now = Date.now(),
  bufferMs = REFRESH_BUFFER_MS
): number | null {
  const next = getNextProductPriceChangeAt(products, now);
  if (next === null) return null;
  return Math.max(0, next - now + bufferMs);
}
