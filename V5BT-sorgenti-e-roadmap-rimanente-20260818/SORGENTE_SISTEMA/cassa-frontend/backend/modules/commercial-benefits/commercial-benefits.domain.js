export const COMMERCIAL_BENEFIT_KINDS = Object.freeze({
  FIXED_DISCOUNT: "fixed_discount",
  VALUE_VOUCHER: "value_voucher",
  PERCENTAGE_DISCOUNT: "percentage_discount",
});

export const VALUE_VOUCHER_RESIDUAL_POLICIES = Object.freeze({
  FORFEIT_REMAINING: "forfeit_remaining",
  KEEP_BALANCE: "keep_balance",
  NO_PARTIAL_USE: "no_partial_use",
});

export const COMMERCIAL_BENEFIT_ACQUISITION_SOURCES = Object.freeze({
  CODE: "code",
  QR: "qr",
  NFC: "nfc",
});

export const COMMERCIAL_BENEFIT_APPLICATION_STATUS = Object.freeze({
  RESERVED: "reserved",
  RELEASED: "released",
  REDEEMED: "redeemed",
  EXPIRED: "expired",
});

const VALID_BENEFIT_KINDS = new Set(Object.values(COMMERCIAL_BENEFIT_KINDS));
const VALID_RESIDUAL_POLICIES = new Set(Object.values(VALUE_VOUCHER_RESIDUAL_POLICIES));
const VALID_ACQUISITION_SOURCES = new Set(Object.values(COMMERCIAL_BENEFIT_ACQUISITION_SOURCES));

function normalizeText(value, limit = 200) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
}

export function moneyToCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100));
}

export function centsToMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(Math.max(0, parsed)) / 100;
}

export function normalizeCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function normalizeBenefitKind(value) {
  const normalized = normalizeText(value, 80).toLowerCase();
  return VALID_BENEFIT_KINDS.has(normalized) ? normalized : "";
}

export function normalizeResidualPolicy(value) {
  const normalized = normalizeText(value, 80).toLowerCase();
  return VALID_RESIDUAL_POLICIES.has(normalized) ? normalized : "";
}

export function normalizeAcquisitionSource(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return VALID_ACQUISITION_SOURCES.has(normalized)
    ? normalized
    : COMMERCIAL_BENEFIT_ACQUISITION_SOURCES.CODE;
}

export function normalizeCommercialBenefitCode(value) {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 12) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function maskCommercialBenefitCode(value) {
  const normalized = normalizeCommercialBenefitCode(value);
  if (!normalized) return "";
  const [first, , last] = normalized.split("-");
  return `${first}-****-${last}`;
}

export function normalizeCommercialBenefitCampaignInput(input = {}, options = {}) {
  const now = normalizeText(options.now ?? new Date().toISOString(), 40);
  const title = normalizeText(input.title ?? input.name, 120);
  const benefitKind = normalizeBenefitKind(input.benefitKind ?? input.kind ?? input.type);
  const amountCents = normalizeCents(input.amountCents ?? moneyToCents(input.amount));
  const faceValueCents = normalizeCents(input.faceValueCents ?? input.valueCents ?? moneyToCents(input.faceValue));
  const percentageBps = normalizeCents(input.percentageBps ?? Math.round((Number(input.percentage) || 0) * 100));
  const maxDiscountCents = normalizeCents(input.maxDiscountCents ?? moneyToCents(input.maxDiscount));
  const residualPolicy = normalizeResidualPolicy(input.residualPolicy);
  const validFrom = normalizeText(input.validFrom ?? now, 40);
  const validUntil = normalizeText(input.validUntil, 40) || null;
  const issuance = input.issuance && typeof input.issuance === "object" ? input.issuance : {};
  const requestedMaxUsageCount = normalizeCents(input.maxUsageCount ?? issuance.maxUsageCount ?? 1);
  const unlimitedUsage =
    input.unlimitedUsage === true ||
    issuance.unlimitedUsage === true ||
    normalizeText(input.maxUsageCount ?? issuance.maxUsageCount, 40).toLowerCase() === "unlimited";
  const requestedQuantity = normalizeCents(input.quantity ?? issuance.quantity ?? 1);
  const codes = [...new Set(
    [
      ...(Array.isArray(input.codes) ? input.codes : []),
      ...(Array.isArray(issuance.codes) ? issuance.codes : []),
      input.code,
      issuance.code,
    ]
      .map(normalizeCommercialBenefitCode)
      .filter(Boolean),
  )];

  return {
    title,
    benefitKind,
    amountCents,
    faceValueCents,
    percentageBps,
    maxDiscountCents,
    residualPolicy,
    validFrom,
    validUntil,
    quantity: Math.max(codes.length, requestedQuantity || 1),
    codes,
    unlimitedUsage,
    maxUsageCount: unlimitedUsage ? 0 : Math.max(requestedMaxUsageCount || 1, 1),
    status: normalizeText(input.status, 40).toLowerCase() === "disabled" ? "disabled" : "active",
    conditions: input.conditions && typeof input.conditions === "object" ? input.conditions : {},
  };
}

export function validateCommercialBenefitCampaignInput(input = {}) {
  const errors = [];
  if (!input.title) {
    errors.push({ field: "title", code: "required", message: "Titolo beneficio obbligatorio." });
  }
  if (!VALID_BENEFIT_KINDS.has(input.benefitKind)) {
    errors.push({ field: "benefitKind", code: "invalid", message: "Tipo beneficio non valido." });
  }
  if (input.validUntil) {
    const fromMs = Date.parse(input.validFrom);
    const untilMs = Date.parse(input.validUntil);
    if (Number.isFinite(fromMs) && Number.isFinite(untilMs) && untilMs < fromMs) {
      errors.push({ field: "validUntil", code: "before_valid_from", message: "Fine validita precedente all'inizio." });
    }
  }

  if (input.benefitKind === COMMERCIAL_BENEFIT_KINDS.FIXED_DISCOUNT) {
    if (input.amountCents <= 0) {
      errors.push({ field: "amountCents", code: "required", message: "Importo sconto obbligatorio." });
    }
    if (input.residualPolicy) {
      errors.push({ field: "residualPolicy", code: "not_allowed", message: "Policy residuo non ammessa per sconto fisso." });
    }
  }

  if (input.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER) {
    if (input.faceValueCents <= 0) {
      errors.push({ field: "faceValueCents", code: "required", message: "Valore buono obbligatorio." });
    }
    if (!VALID_RESIDUAL_POLICIES.has(input.residualPolicy)) {
      errors.push({ field: "residualPolicy", code: "required", message: "Policy residuo obbligatoria per buono valore." });
    }
  }

  if (input.benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT) {
    if (input.percentageBps <= 0 || input.percentageBps > 10000) {
      errors.push({ field: "percentageBps", code: "invalid", message: "Percentuale sconto non valida." });
    }
    if (input.residualPolicy) {
      errors.push({ field: "residualPolicy", code: "not_allowed", message: "Policy residuo non ammessa per sconto percentuale." });
    }
  }

  return { ok: errors.length === 0, errors };
}

function defaultIdFactory(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function defaultCodeFactory(index) {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${index}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .padEnd(12, "0")
    .slice(0, 12);
  return normalizeCommercialBenefitCode(seed);
}

export function createCommercialBenefitCampaign(input = {}, options = {}) {
  const normalized = normalizeCommercialBenefitCampaignInput(input, options);
  const validation = validateCommercialBenefitCampaignInput(normalized);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, campaign: null, coupons: [] };
  }

  const now = normalizeText(options.now ?? new Date().toISOString(), 40);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const codeFactory = typeof options.codeFactory === "function" ? options.codeFactory : defaultCodeFactory;
  const campaignId = normalizeText(input.id ?? idFactory("cb_campaign"), 120);
  const campaign = {
    id: campaignId,
    title: normalized.title,
    benefitKind: normalized.benefitKind,
    status: normalized.status,
    amountCents: normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.FIXED_DISCOUNT ? normalized.amountCents : 0,
    faceValueCents: normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER ? normalized.faceValueCents : 0,
    percentageBps:
      normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT ? normalized.percentageBps : 0,
    maxDiscountCents:
      normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT ? normalized.maxDiscountCents : 0,
    residualPolicy:
      normalized.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER ? normalized.residualPolicy : null,
    validFrom: normalized.validFrom,
    validUntil: normalized.validUntil,
    conditions: normalized.conditions,
    createdAt: now,
    updatedAt: now,
  };

  const codes = normalized.codes.length
    ? normalized.codes
    : Array.from({ length: normalized.quantity }, (_, index) => codeFactory(index + 1)).filter(Boolean);
  const uniqueCodes = [...new Set(codes)];
  const coupons = uniqueCodes.map((code, index) => ({
    id: normalizeText(idFactory("cb_coupon"), 120),
    campaignId,
    code,
    codeMasked: maskCommercialBenefitCode(code),
    status: "active",
    benefitKind: campaign.benefitKind,
    residualPolicy: campaign.residualPolicy,
    faceValueCents: campaign.faceValueCents,
    balanceCents:
      campaign.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER ? campaign.faceValueCents : 0,
    usageCount: 0,
    maxUsageCount: normalized.maxUsageCount,
    unlimitedUsage: normalized.unlimitedUsage,
    issueSequence: index + 1,
    createdAt: now,
    updatedAt: now,
  }));

  return { ok: true, errors: [], campaign, coupons };
}

export function isCommercialBenefitCampaignActive(campaign, now = new Date().toISOString()) {
  if (!campaign || typeof campaign !== "object") return false;
  if (String(campaign.status ?? "active") !== "active") return false;
  const nowMs = Date.parse(now);
  const fromMs = Date.parse(campaign.validFrom ?? "");
  const untilMs = Date.parse(campaign.validUntil ?? "");
  if (Number.isFinite(nowMs) && Number.isFinite(fromMs) && nowMs < fromMs) return false;
  if (Number.isFinite(nowMs) && Number.isFinite(untilMs) && nowMs > untilMs) return false;
  return true;
}

export function isCommercialBenefitCouponReusable(coupon) {
  if (!coupon || typeof coupon !== "object") return false;
  if (coupon.unlimitedUsage === true) return true;
  return normalizeCents(coupon.maxUsageCount) === 0;
}

export function calculateCommercialBenefitApplication({ campaign, coupon = null, payableCents, now }) {
  const benefitKind = normalizeBenefitKind(campaign?.benefitKind);
  const eligibleSubtotalCents = normalizeCents(payableCents);
  if (!isCommercialBenefitCampaignActive(campaign, now)) {
    return { ok: false, code: "campaign_not_active", message: "Beneficio non attivo." };
  }
  if (coupon) {
    const status = normalizeText(coupon.status, 40).toLowerCase() || "active";
    if (!["active", "partially_redeemed"].includes(status)) {
      return { ok: false, code: "coupon_not_active", message: "Buono non utilizzabile." };
    }
    const maxUsageCount = normalizeCents(coupon.maxUsageCount ?? 1);
    if (!isCommercialBenefitCouponReusable(coupon) && maxUsageCount > 0) {
      const usageCount = normalizeCents(coupon.usageCount);
      if (usageCount >= maxUsageCount) {
        return { ok: false, code: "coupon_usage_limit_reached", message: "Buono gia utilizzato." };
      }
    }
  }
  if (eligibleSubtotalCents <= 0) {
    return { ok: false, code: "empty_payable", message: "Nessun importo pagabile." };
  }

  if (benefitKind === COMMERCIAL_BENEFIT_KINDS.FIXED_DISCOUNT) {
    const amountCents = Math.min(normalizeCents(campaign.amountCents), eligibleSubtotalCents);
    return {
      ok: true,
      benefitKind,
      benefitAmountCents: amountCents,
      payableBeforeCents: eligibleSubtotalCents,
      payableAfterCents: Math.max(0, eligibleSubtotalCents - amountCents),
      couponStatusAfter: coupon ? (isCommercialBenefitCouponReusable(coupon) ? "active" : "redeemed") : null,
    };
  }

  if (benefitKind === COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT) {
    const grossDiscount = Math.round((eligibleSubtotalCents * normalizeCents(campaign.percentageBps)) / 10000);
    const cap = normalizeCents(campaign.maxDiscountCents);
    const amountCents = Math.min(cap > 0 ? Math.min(grossDiscount, cap) : grossDiscount, eligibleSubtotalCents);
    return {
      ok: true,
      benefitKind,
      benefitAmountCents: amountCents,
      payableBeforeCents: eligibleSubtotalCents,
      payableAfterCents: Math.max(0, eligibleSubtotalCents - amountCents),
      couponStatusAfter: coupon ? (isCommercialBenefitCouponReusable(coupon) ? "active" : "redeemed") : null,
    };
  }

  if (benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER) {
    const residualPolicy = normalizeResidualPolicy(coupon?.residualPolicy ?? campaign.residualPolicy);
    const balanceBeforeCents = normalizeCents(coupon?.balanceCents ?? campaign.faceValueCents);
    if (balanceBeforeCents <= 0) {
      return { ok: false, code: "empty_balance", message: "Buono senza saldo disponibile." };
    }
    if (
      residualPolicy === VALUE_VOUCHER_RESIDUAL_POLICIES.NO_PARTIAL_USE &&
      eligibleSubtotalCents < balanceBeforeCents
    ) {
      return {
        ok: false,
        code: "partial_use_not_allowed",
        message: "Uso parziale non consentito per questo buono.",
        balanceBeforeCents,
        payableBeforeCents: eligibleSubtotalCents,
      };
    }
    const benefitAmountCents = Math.min(balanceBeforeCents, eligibleSubtotalCents);
    const rawRemainderCents = Math.max(0, balanceBeforeCents - benefitAmountCents);
    const balanceAfterCents =
      residualPolicy === VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE ? rawRemainderCents : 0;
    const forfeitedCents =
      residualPolicy === VALUE_VOUCHER_RESIDUAL_POLICIES.FORFEIT_REMAINING ? rawRemainderCents : 0;
    return {
      ok: true,
      benefitKind,
      residualPolicy,
      benefitAmountCents,
      payableBeforeCents: eligibleSubtotalCents,
      payableAfterCents: Math.max(0, eligibleSubtotalCents - benefitAmountCents),
      balanceBeforeCents,
      balanceAfterCents,
      forfeitedCents,
      couponStatusAfter: balanceAfterCents > 0 ? "partially_redeemed" : "redeemed",
    };
  }

  return { ok: false, code: "invalid_benefit_kind", message: "Tipo beneficio non valido." };
}

export function ensureCommercialBenefitCollections(db) {
  if (!db || typeof db !== "object") return;
  if (!Array.isArray(db.commercialBenefitCampaigns)) db.commercialBenefitCampaigns = [];
  if (!Array.isArray(db.commercialBenefitCoupons)) db.commercialBenefitCoupons = [];
  if (!Array.isArray(db.commercialBenefitApplications)) db.commercialBenefitApplications = [];
  if (!Array.isArray(db.commercialBenefitRedemptions)) db.commercialBenefitRedemptions = [];
}

export function normalizeCommercialBenefitApplicationRef(value) {
  if (typeof value === "string") return normalizeText(value, 120);
  if (!value || typeof value !== "object") return "";
  return normalizeText(value.applicationId ?? value.id ?? value.reservationId, 120);
}
