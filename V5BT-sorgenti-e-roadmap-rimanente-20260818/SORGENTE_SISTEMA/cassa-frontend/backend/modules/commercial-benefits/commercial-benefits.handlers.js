import { createHash, randomUUID } from "node:crypto";
import {
  COMMERCIAL_BENEFIT_APPLICATION_STATUS,
  COMMERCIAL_BENEFIT_KINDS,
  VALUE_VOUCHER_RESIDUAL_POLICIES,
  calculateCommercialBenefitApplication,
  centsToMoney,
  createCommercialBenefitCampaign,
  ensureCommercialBenefitCollections,
  maskCommercialBenefitCode,
  normalizeAcquisitionSource,
  normalizeCents,
  normalizeCommercialBenefitApplicationRef,
  normalizeCommercialBenefitCampaignInput,
  normalizeCommercialBenefitCode,
  isCommercialBenefitCouponReusable,
  validateCommercialBenefitCampaignInput,
} from "./commercial-benefits.domain.js";

export function compactId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function normalizeText(value, limit = 200) {
  return String(value ?? "").trim().slice(0, limit);
}

function hashToken(value) {
  const token = normalizeText(value, 4096);
  return token ? createHash("sha256").update(token).digest("hex") : "";
}

function formatMoneyCents(cents) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(centsToMoney(cents));
}

function normalizeBenefitCategory(value, benefitKind = "") {
  const normalized = normalizeText(value, 40).toLowerCase();
  if (["discount", "sconto", "fixed_discount"].includes(normalized)) return "discount";
  if (["promotion", "promozione", "promo", "percentage_discount"].includes(normalized)) return "promotion";
  if (["gift_card", "giftcard", "carta_regalo", "regalo"].includes(normalized)) return "gift_card";
  if (["voucher", "buono", "value_voucher"].includes(normalized)) return "voucher";
  if (benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT) return "promotion";
  if (benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER) return "voucher";
  return "discount";
}

function normalizeBenefitKindFromCategory(category, requestedKind = "") {
  const normalizedKind = normalizeText(requestedKind, 80).toLowerCase();
  if (Object.values(COMMERCIAL_BENEFIT_KINDS).includes(normalizedKind)) return normalizedKind;
  if (category === "promotion") return COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT;
  if (category === "voucher" || category === "gift_card") return COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER;
  return COMMERCIAL_BENEFIT_KINDS.FIXED_DISCOUNT;
}

function benefitCategoryLabel(category) {
  switch (normalizeBenefitCategory(category)) {
    case "promotion":
      return "Promozione";
    case "voucher":
      return "Buono";
    case "gift_card":
      return "Carta regalo";
    case "discount":
    default:
      return "Sconto";
  }
}

function normalizeCommercialBenefitConditions(input = {}, previous = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const fallback = previous && typeof previous === "object" ? previous : {};
  const print = raw.print && typeof raw.print === "object" ? raw.print : {};
  const previousPrint = fallback.print && typeof fallback.print === "object" ? fallback.print : {};
  const conditions = {
    ...fallback,
    ...raw,
    benefitCategory: normalizeBenefitCategory(raw.benefitCategory ?? fallback.benefitCategory, raw.benefitKind),
    minimumSpendCents: normalizeCents(raw.minimumSpendCents ?? fallback.minimumSpendCents),
    notes: normalizeText(raw.notes ?? fallback.notes, 500),
    print: {
      ...previousPrint,
      ...print,
      title: normalizeText(print.title ?? previousPrint.title, 120),
      message: normalizeText(print.message ?? previousPrint.message, 240),
      omitAmountOnGiftReceipt:
        print.omitAmountOnGiftReceipt === true ||
        raw.omitAmountOnGiftReceipt === true ||
        previousPrint.omitAmountOnGiftReceipt === true,
      qrOnlyGiftReceipt:
        print.qrOnlyGiftReceipt === true ||
        raw.qrOnlyGiftReceipt === true ||
        previousPrint.qrOnlyGiftReceipt === true,
    },
  };
  return conditions;
}

export function publicCampaignResource(db, campaign) {
  const campaignId = normalizeText(campaign?.id, 120);
  const coupons = (Array.isArray(db.commercialBenefitCoupons) ? db.commercialBenefitCoupons : [])
    .filter((coupon) => normalizeText(coupon.campaignId, 120) === campaignId)
    .map((coupon) => ({
      id: coupon.id,
      campaignId: coupon.campaignId,
      codeMasked: coupon.codeMasked ?? maskCommercialBenefitCode(coupon.code),
      status: coupon.status,
      benefitKind: coupon.benefitKind,
      residualPolicy: coupon.residualPolicy ?? null,
      faceValueCents: normalizeCents(coupon.faceValueCents),
      balanceCents: normalizeCents(coupon.balanceCents),
      usageCount: normalizeCents(coupon.usageCount),
      maxUsageCount: normalizeCents(coupon.maxUsageCount),
      unlimitedUsage: coupon.unlimitedUsage === true,
      issueSequence: normalizeCents(coupon.issueSequence),
      createdAt: coupon.createdAt,
      updatedAt: coupon.updatedAt,
    }));
  const redemptions = (Array.isArray(db.commercialBenefitRedemptions) ? db.commercialBenefitRedemptions : [])
    .filter((redemption) => normalizeText(redemption.campaignId, 120) === campaignId);
  const conditions = normalizeCommercialBenefitConditions(campaign?.conditions ?? {}, {});
  const benefitCategory = normalizeBenefitCategory(conditions.benefitCategory, campaign?.benefitKind);
  return {
    ...campaign,
    conditions,
    benefitCategory,
    benefitCategoryLabel: benefitCategoryLabel(benefitCategory),
    amount: centsToMoney(campaign?.amountCents),
    faceValue: centsToMoney(campaign?.faceValueCents),
    maxDiscount: centsToMoney(campaign?.maxDiscountCents),
    percentage: Math.round(normalizeCents(campaign?.percentageBps)) / 100,
    coupons,
    couponCount: coupons.length,
    activeCouponCount: coupons.filter((coupon) => coupon.status === "active").length,
    redeemedCouponCount: coupons.filter((coupon) => coupon.status === "redeemed").length,
    redemptionsCount: redemptions.length,
    redeemedAmountCents: redemptions.reduce((sum, entry) => sum + normalizeCents(entry.benefitAmountCents), 0),
  };
}

export function ensureBenefitCategoryPayload(payload = {}) {
  const category = normalizeBenefitCategory(
    payload.benefitCategory ??
      payload.category ??
      payload.kindLabel ??
      payload.conditions?.benefitCategory,
    payload.benefitKind,
  );
  const benefitKind = normalizeBenefitKindFromCategory(category, payload.benefitKind ?? payload.kind ?? payload.type);
  const conditions = normalizeCommercialBenefitConditions(
    {
      ...(payload.conditions && typeof payload.conditions === "object" ? payload.conditions : {}),
      benefitCategory: category,
      minimumSpendCents:
        payload.minimumSpendCents ??
        Math.round((Number(payload.minimumSpend) || 0) * 100),
      notes: payload.notes ?? payload.conditions?.notes,
      print: {
        ...(payload.conditions?.print && typeof payload.conditions.print === "object"
          ? payload.conditions.print
          : {}),
        omitAmountOnGiftReceipt:
          payload.omitAmountOnGiftReceipt === true ||
          payload.print?.omitAmountOnGiftReceipt === true ||
          payload.conditions?.print?.omitAmountOnGiftReceipt === true,
        qrOnlyGiftReceipt:
          payload.qrOnlyGiftReceipt === true ||
          payload.print?.qrOnlyGiftReceipt === true ||
          payload.conditions?.print?.qrOnlyGiftReceipt === true,
        title: payload.printTitle ?? payload.print?.title,
        message: payload.printMessage ?? payload.print?.message,
      },
    },
    {},
  );
  return {
    ...payload,
    benefitKind,
    residualPolicy:
      benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER
        ? payload.residualPolicy || VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE
        : "",
    conditions,
  };
}

export function updateCommercialBenefitCampaignFromPayload(campaign, payload = {}, now) {
  const mergedConditions = normalizeCommercialBenefitConditions(payload.conditions ?? {}, campaign.conditions ?? {});
  const benefitCategory = normalizeBenefitCategory(
    payload.benefitCategory ?? mergedConditions.benefitCategory,
    payload.benefitKind ?? campaign.benefitKind,
  );
  const benefitKind = normalizeBenefitKindFromCategory(
    benefitCategory,
    payload.benefitKind ?? payload.kind ?? payload.type ?? campaign.benefitKind,
  );
  const normalized = normalizeCommercialBenefitCampaignInput(
    {
      ...campaign,
      ...payload,
      benefitKind,
      residualPolicy:
        benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER
          ? payload.residualPolicy ?? campaign.residualPolicy ?? VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE
          : "",
      conditions: {
        ...mergedConditions,
        benefitCategory,
      },
      quantity: 1,
    },
    { now },
  );
  const validation = validateCommercialBenefitCampaignInput(normalized);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  campaign.title = normalized.title;
  campaign.benefitKind = normalized.benefitKind;
  campaign.status = normalized.status;
  campaign.amountCents = normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.FIXED_DISCOUNT ? normalized.amountCents : 0;
  campaign.faceValueCents = normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER ? normalized.faceValueCents : 0;
  campaign.percentageBps = normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT ? normalized.percentageBps : 0;
  campaign.maxDiscountCents = normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT ? normalized.maxDiscountCents : 0;
  campaign.residualPolicy = normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER ? normalized.residualPolicy : null;
  campaign.validFrom = normalized.validFrom;
  campaign.validUntil = normalized.validUntil;
  campaign.conditions = normalized.conditions;
  campaign.updatedAt = now;
  return { ok: true, campaign };
}

function encodeEscPosQrPayloadBytes(value) {
  return Array.from(Buffer.from(String(value ?? ""), "utf8"));
}

function buildEscPosRawBase64Marker(bytes) {
  return `{{ESC_POS_RAW_BASE64:${Buffer.from(bytes).toString("base64")}}}`;
}

function buildEscPosQrCodeMarker(payload) {
  const data = encodeEscPosQrPayloadBytes(payload);
  const storeLength = data.length + 3;
  if (storeLength > 65535) return "";
  const pL = storeLength & 0xff;
  const pH = (storeLength >> 8) & 0xff;
  return buildEscPosRawBase64Marker([
    0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x07,
    0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
    0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30,
    ...data,
    0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
  ]);
}

export function findCouponById(db, couponId) {
  const id = normalizeText(couponId, 120);
  if (!id) return null;
  return (Array.isArray(db.commercialBenefitCoupons) ? db.commercialBenefitCoupons : []).find(
    (coupon) => normalizeText(coupon.id, 120) === id,
  ) ?? null;
}

export function resolveDefaultBenefitPrinterId(settings = {}) {
  const printers = Array.isArray(settings.printers) ? settings.printers : [];
  const printer = printers.find(
    (entry) =>
      entry &&
      entry.active !== false &&
      entry.status !== "disabled" &&
      String(entry.purpose ?? "generic").trim().toLowerCase() !== "fiscal" &&
      normalizeText(entry.id, 120),
  );
  return normalizeText(printer?.id, 120);
}

export function buildCommercialBenefitPrintText({ campaign, coupon, options = {}, now }) {
  const conditions = normalizeCommercialBenefitConditions(campaign.conditions ?? {}, {});
  const category = normalizeBenefitCategory(conditions.benefitCategory, campaign.benefitKind);
  const printOptions = conditions.print && typeof conditions.print === "object" ? conditions.print : {};
  const omitAmount =
    options.omitAmount === true ||
    (category === "gift_card" && printOptions.omitAmountOnGiftReceipt === true);
  const qrOnly =
    options.qrOnly === true ||
    (category === "gift_card" && printOptions.qrOnlyGiftReceipt === true);
  const code = normalizeCommercialBenefitCode(coupon.code);
  const qrMarker = buildEscPosQrCodeMarker(code);
  const divider = "------------------------------------------";
  const title = normalizeText(printOptions.title || campaign.title || benefitCategoryLabel(category), 40);
  const lines = [
    title.toUpperCase(),
    divider,
    `Tipo: ${benefitCategoryLabel(category)}`,
    qrOnly ? null : `Nome: ${campaign.title}`,
  ];
  if (!omitAmount && !qrOnly) {
    if (campaign.benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT) {
      const percentage = (normalizeCents(campaign.percentageBps) / 100).toLocaleString("it-IT", {
        maximumFractionDigits: 2,
      });
      lines.push(`Valore: ${percentage}%`);
      if (campaign.maxDiscountCents > 0) lines.push(`Massimo: ${formatMoneyCents(campaign.maxDiscountCents)}`);
    } else if (campaign.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER) {
      lines.push(`Valore: ${formatMoneyCents(coupon.faceValueCents || campaign.faceValueCents)}`);
      lines.push(`Saldo: ${formatMoneyCents(coupon.balanceCents)}`);
    } else {
      lines.push(`Valore: ${formatMoneyCents(campaign.amountCents)}`);
    }
  }
  if (!qrOnly) {
    lines.push(`Codice: ${coupon.codeMasked ?? maskCommercialBenefitCode(code)}`);
    if (campaign.validUntil) lines.push(`Scade: ${campaign.validUntil}`);
    if (printOptions.message) lines.push(printOptions.message);
  }
  lines.push(divider, "Scansiona il QR in cassa.", qrMarker, divider);
  if (!qrOnly) lines.push("Documento interno non fiscale.");
  lines.push(`Stampato: ${new Date(now).toLocaleString("it-IT")}`, divider);
  return lines.filter(Boolean).join("\n");
}

function collectIssueTokens(payload, names) {
  const issuance = payload?.issuance && typeof payload.issuance === "object" ? payload.issuance : {};
  return names
    .flatMap((name) => [payload?.[name], issuance?.[name]])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => normalizeText(value, 4096))
    .filter(Boolean);
}

export function applyIssueTokenHashes(coupons, payload) {
  const qrTokens = collectIssueTokens(payload, ["qrTokens", "qrPayloads", "qrCodes", "qrToken", "qrPayload"]);
  const nfcTokens = collectIssueTokens(payload, ["nfcTokens", "nfcIds", "nfcToken", "nfcId"]);
  return coupons.map((coupon, index) => {
    const qrTokenHash = hashToken(qrTokens[index]);
    const nfcTokenHash = hashToken(nfcTokens[index]);
    return {
      ...coupon,
      ...(qrTokenHash ? { qrTokenHash } : {}),
      ...(nfcTokenHash ? { nfcTokenHash } : {}),
    };
  });
}

export function duplicateTokenHashes(existingCoupons, nextCoupons, key) {
  const existingHashes = new Set(
    existingCoupons
      .map((coupon) => normalizeText(coupon?.[key], 160))
      .filter(Boolean),
  );
  const seen = new Set();
  const duplicated = [];
  for (const coupon of nextCoupons) {
    const hash = normalizeText(coupon?.[key], 160);
    if (!hash) continue;
    if (existingHashes.has(hash) || seen.has(hash)) {
      duplicated.push(coupon.codeMasked ?? maskCommercialBenefitCode(coupon.code));
    }
    seen.add(hash);
  }
  return duplicated;
}

export function findCoupon(db, source, token) {
  const coupons = Array.isArray(db.commercialBenefitCoupons) ? db.commercialBenefitCoupons : [];
  const findByCode = () => {
    const code = normalizeCommercialBenefitCode(token);
    if (!code) return null;
    return coupons.find((coupon) => normalizeCommercialBenefitCode(coupon.code) === code) ?? null;
  };
  if (source === "code") return findByCode();
  const tokenHash = hashToken(token);
  if (!tokenHash) return null;
  const key = source === "qr" ? "qrTokenHash" : "nfcTokenHash";
  return coupons.find((coupon) => normalizeText(coupon?.[key], 160) === tokenHash) ?? findByCode();
}

export function resolveBenefitAcquisitionToken(payload, source) {
  const sourceToken =
    source === "nfc"
      ? payload.nfcToken ?? payload.nfcId ?? payload.code
      : source === "qr"
        ? payload.qrPayload ?? payload.qrToken ?? payload.qrCode ?? payload.code
        : payload.code;
  return normalizeText(
    sourceToken ??
      payload.commercialBenefitToken ??
      payload.benefitToken ??
      payload.token,
    4096,
  );
}

export function findCampaign(db, campaignId) {
  const id = normalizeText(campaignId, 120);
  if (!id) return null;
  return (Array.isArray(db.commercialBenefitCampaigns) ? db.commercialBenefitCampaigns : []).find(
    (campaign) => normalizeText(campaign.id, 120) === id,
  ) ?? null;
}

export function activeReservationForCoupon(db, couponId) {
  const id = normalizeText(couponId, 120);
  if (!id) return null;
  const nowMs = Date.now();
  return (Array.isArray(db.commercialBenefitApplications) ? db.commercialBenefitApplications : []).find(
    (entry) => {
      if (normalizeText(entry.couponId, 120) !== id) return false;
      if (entry.status !== COMMERCIAL_BENEFIT_APPLICATION_STATUS.RESERVED) return false;
      const expiresAtMs = Date.parse(entry.reservationExpiresAt ?? "");
      return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
    },
  ) ?? null;
}

export function activeReservationForReusableCoupon(db, couponId, clientApplicationId, deviceUuid) {
  const id = normalizeText(couponId, 120);
  const applicationId = normalizeText(clientApplicationId, 120);
  const requestDeviceUuid = normalizeText(deviceUuid, 160);
  if (!id || !applicationId || !requestDeviceUuid) return null;
  const nowMs = Date.now();
  return (Array.isArray(db.commercialBenefitApplications) ? db.commercialBenefitApplications : []).find(
    (entry) => {
      if (normalizeText(entry.couponId, 120) !== id) return false;
      if (entry.status !== COMMERCIAL_BENEFIT_APPLICATION_STATUS.RESERVED) return false;
      if (normalizeText(entry.clientApplicationId, 120) !== applicationId) return false;
      if (normalizeText(entry.deviceUuid, 160) !== requestDeviceUuid) return false;
      const expiresAtMs = Date.parse(entry.reservationExpiresAt ?? "");
      return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
    },
  ) ?? null;
}

export function findApplication(db, applicationId) {
  const id = normalizeText(applicationId, 120);
  if (!id) return null;
  return (Array.isArray(db.commercialBenefitApplications) ? db.commercialBenefitApplications : []).find(
    (entry) => normalizeText(entry.id, 120) === id,
  ) ?? null;
}

export function buildPublicApplication(application) {
  if (!application) return null;
  return {
    id: application.id,
    campaignId: application.campaignId,
    couponId: application.couponId,
    title: application.title,
    benefitKind: application.benefitKind,
    residualPolicy: application.residualPolicy ?? null,
    acquisitionSource: application.acquisitionSource,
    codeMasked: application.codeMasked ?? null,
    status: application.status,
    benefitAmountCents: application.benefitAmountCents,
    benefitAmount: centsToMoney(application.benefitAmountCents),
    payableBeforeCents: application.payableBeforeCents,
    payableBefore: centsToMoney(application.payableBeforeCents),
    payableAfterCents: application.payableAfterCents,
    payableAfter: centsToMoney(application.payableAfterCents),
    balanceBeforeCents: application.balanceBeforeCents ?? 0,
    balanceAfterPreviewCents: application.balanceAfterPreviewCents ?? 0,
    forfeitedPreviewCents: application.forfeitedPreviewCents ?? 0,
    reservationExpiresAt: application.reservationExpiresAt,
  };
}

export function redeemCommercialBenefitApplications(db, applicationRefs = [], context = {}) {
  ensureCommercialBenefitCollections(db);
  const applicationIds = [...new Set(
    (Array.isArray(applicationRefs) ? applicationRefs : [])
      .map(normalizeCommercialBenefitApplicationRef)
      .filter(Boolean),
  )];
  if (applicationIds.length === 0) return [];

  const now = normalizeText(context.now ?? new Date().toISOString(), 40);
  const redeemed = [];
  for (const applicationId of applicationIds) {
    const application = findApplication(db, applicationId);
    if (!application) {
      const error = new Error("Applicazione beneficio non trovata.");
      error.code = "COMMERCIAL_BENEFIT_APPLICATION_NOT_FOUND";
      error.details = { applicationId };
      throw error;
    }
    if (application.status === COMMERCIAL_BENEFIT_APPLICATION_STATUS.REDEEMED) {
      redeemed.push(application);
      continue;
    }
    if (application.status !== COMMERCIAL_BENEFIT_APPLICATION_STATUS.RESERVED) {
      const error = new Error("Applicazione beneficio non riscattabile.");
      error.code = "COMMERCIAL_BENEFIT_APPLICATION_NOT_REDEEMABLE";
      error.details = { applicationId, status: application.status };
      throw error;
    }

    const couponIndex = db.commercialBenefitCoupons.findIndex(
      (coupon) => normalizeText(coupon.id, 120) === normalizeText(application.couponId, 120),
    );
    if (couponIndex < 0) {
      const error = new Error("Buono collegato non trovato.");
      error.code = "COMMERCIAL_BENEFIT_COUPON_NOT_FOUND";
      error.details = { applicationId, couponId: application.couponId };
      throw error;
    }

    const coupon = db.commercialBenefitCoupons[couponIndex];
    const nextCoupon = {
      ...coupon,
      balanceCents: normalizeCents(application.balanceAfterPreviewCents),
      status: application.couponStatusAfter || "redeemed",
      usageCount: normalizeCents(coupon.usageCount) + 1,
      updatedAt: now,
    };
    db.commercialBenefitCoupons[couponIndex] = nextCoupon;
    application.status = COMMERCIAL_BENEFIT_APPLICATION_STATUS.REDEEMED;
    application.redeemedAt = now;
    application.paymentId = normalizeText(context.paymentId, 120) || null;
    application.paymentTxId = normalizeText(context.paymentTxId, 120) || null;
    application.updatedAt = now;

    db.commercialBenefitRedemptions.push({
      id: compactId("cb_redemption"),
      applicationId: application.id,
      campaignId: application.campaignId,
      couponId: application.couponId,
      paymentId: application.paymentId,
      paymentTxId: application.paymentTxId,
      benefitKind: application.benefitKind,
      benefitAmountCents: normalizeCents(application.benefitAmountCents),
      balanceBeforeCents: normalizeCents(application.balanceBeforeCents),
      balanceAfterCents: normalizeCents(application.balanceAfterPreviewCents),
      forfeitedCents: normalizeCents(application.forfeitedPreviewCents),
      redeemedAt: now,
      userId: normalizeText(context.user?.id, 120) || null,
      username: normalizeText(context.user?.username, 120) || null,
      deviceUuid: normalizeText(context.session?.deviceUuid, 160) || null,
    });
    redeemed.push(application);
  }
  return redeemed;
}

export function createCommercialBenefitsHandlers({
  createCampaign,
  listCampaignsView,
  printCoupon,
  readJsonBody,
  releaseBenefit,
  sendJson,
  updateCampaign,
  updateCoupon,
  validateBenefit,
}) {

  async function handleListCampaigns(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await listCampaignsView(payload, req?.__authContext));
  }

  async function handleCreateCampaign(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 201, await createCampaign(payload, req?.__authContext));
  }

  async function handleUpdateCampaign(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await updateCampaign(payload, req?.__authContext));
  }

  async function handleUpdateCoupon(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await updateCoupon(payload, req?.__authContext));
  }

  async function handlePrintCoupon(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await printCoupon(payload, req?.__authContext));
  }

  async function handleValidate(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await validateBenefit(payload, req?.__authContext));
  }

  async function handleRelease(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await releaseBenefit(payload, req?.__authContext));
  }

  return {
    "commercialBenefits.listCampaigns": handleListCampaigns,
    "commercialBenefits.createCampaign": handleCreateCampaign,
    "commercialBenefits.updateCampaign": handleUpdateCampaign,
    "commercialBenefits.updateCoupon": handleUpdateCoupon,
    "commercialBenefits.printCoupon": handlePrintCoupon,
    "commercialBenefits.validate": handleValidate,
    "commercialBenefits.release": handleRelease,
  };
}
