/**
 * Write model delle sei route che mutano campagne, buoni e applicazioni
 * commerciali (P2b, MIG-033, dominio `commerce`).
 *
 * `printCoupon` legge l'app-state due volte di proposito: legge, prepara il
 * buono, accoda il job di stampa -- un effetto esterno -- e solo dopo rilegge in
 * `latestDb` cio che l'accodamento ha nel frattempo scritto, per non
 * sovrascriverlo. Le due letture non vanno collassate: si perderebbe il job di
 * stampa.
 *
 * Ogni funzione riceve il contesto di autenticazione gia risolto dal middleware
 * quando c'e (`req.__authContext`), e altrimenti se lo ricava da
 * `validateSessionContext`, esattamente come faceva il handler.
 */
import {
  COMMERCIAL_BENEFIT_APPLICATION_STATUS,
  COMMERCIAL_BENEFIT_KINDS,
  calculateCommercialBenefitApplication,
  createCommercialBenefitCampaign,
  ensureCommercialBenefitCollections,
  isCommercialBenefitCouponReusable,
  maskCommercialBenefitCode,
  normalizeAcquisitionSource,
  normalizeCents,
  normalizeCommercialBenefitApplicationRef,
  normalizeCommercialBenefitCode,
} from "./commercial-benefits.domain.js";
import {
  activeReservationForCoupon,
  activeReservationForReusableCoupon,
  applyIssueTokenHashes,
  buildCommercialBenefitPrintText,
  buildPublicApplication,
  compactId,
  duplicateTokenHashes,
  ensureBenefitCategoryPayload,
  findApplication,
  findCampaign,
  findCoupon,
  findCouponById,
  normalizeText,
  publicCampaignResource,
  resolveBenefitAcquisitionToken,
  resolveDefaultBenefitPrinterId,
  updateCommercialBenefitCampaignFromPayload,
} from "./commercial-benefits.handlers.js";

export function createCommercialBenefitsWriteModel({
  HttpError,
  appendAuditEvent,
  buildAuditActor,
  enqueuePrintSpoolJob,
  nowIso,
  readDb,
  validateSessionContext,
  writeDb,
}) {
  async function createCampaign(richiesta, authContext) {
    const payload = ensureBenefitCategoryPayload(richiesta);
    const db = await readDb();
    const { user } = authContext?.user ? authContext : validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    const now = nowIso();
    const result = createCommercialBenefitCampaign(payload, {
      now,
      idFactory: compactId,
    });
    if (!result.ok) {
      throw new HttpError(400, "Campagna beneficio non valida.", {
        code: "COMMERCIAL_BENEFIT_CAMPAIGN_INVALID",
        details: { errors: result.errors },
      });
    }

    result.coupons = applyIssueTokenHashes(result.coupons, payload);

    const existingCodes = new Set(
      db.commercialBenefitCoupons
        .map((coupon) => normalizeCommercialBenefitCode(coupon.code))
        .filter(Boolean),
    );
    const duplicatedCodes = result.coupons
      .map((coupon) => coupon.code)
      .filter((code) => existingCodes.has(code));
    if (duplicatedCodes.length > 0) {
      throw new HttpError(409, "Codice beneficio gia presente.", {
        code: "COMMERCIAL_BENEFIT_CODE_DUPLICATE",
        details: { codes: duplicatedCodes.map(maskCommercialBenefitCode) },
      });
    }
    const duplicatedQrTokens = duplicateTokenHashes(db.commercialBenefitCoupons, result.coupons, "qrTokenHash");
    const duplicatedNfcTokens = duplicateTokenHashes(db.commercialBenefitCoupons, result.coupons, "nfcTokenHash");
    if (duplicatedQrTokens.length > 0 || duplicatedNfcTokens.length > 0) {
      throw new HttpError(409, "Token beneficio gia presente.", {
        code: "COMMERCIAL_BENEFIT_TOKEN_DUPLICATE",
        details: {
          qr: duplicatedQrTokens,
          nfc: duplicatedNfcTokens,
        },
      });
    }

    db.commercialBenefitCampaigns.push(result.campaign);
    db.commercialBenefitCoupons.push(...result.coupons);
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "commercial_benefit.campaign_created",
      entityType: "commercial_benefit_campaign",
      entityId: result.campaign.id,
      payload: {
        campaignId: result.campaign.id,
        benefitKind: result.campaign.benefitKind,
        residualPolicy: result.campaign.residualPolicy ?? null,
        couponsCount: result.coupons.length,
      },
    });
    if (!db.meta || typeof db.meta !== "object") db.meta = {};
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    return {
      ok: true,
      campaign: publicCampaignResource(db, result.campaign),
      coupons: publicCampaignResource(db, result.campaign).coupons,
    };
  }

  async function updateCampaign(payload, authContext) {
    const db = await readDb();
    const { user } = authContext?.user ? authContext : validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    const campaign = findCampaign(db, payload.campaignId ?? payload.id);
    if (!campaign) {
      throw new HttpError(404, "Campagna beneficio non trovata.", {
        code: "COMMERCIAL_BENEFIT_CAMPAIGN_NOT_FOUND",
      });
    }
    const now = nowIso();
    const update = updateCommercialBenefitCampaignFromPayload(campaign, ensureBenefitCategoryPayload(payload), now);
    if (!update.ok) {
      throw new HttpError(400, "Campagna beneficio non valida.", {
        code: "COMMERCIAL_BENEFIT_CAMPAIGN_INVALID",
        details: { errors: update.errors },
      });
    }
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "commercial_benefit.campaign_updated",
      entityType: "commercial_benefit_campaign",
      entityId: campaign.id,
      payload: {
        campaignId: campaign.id,
        benefitKind: campaign.benefitKind,
        status: campaign.status,
      },
    });
    if (!db.meta || typeof db.meta !== "object") db.meta = {};
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    return {
      ok: true,
      campaign: publicCampaignResource(db, campaign),
    };
  }

  async function updateCoupon(payload, authContext) {
    const db = await readDb();
    const { user } = authContext?.user ? authContext : validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    const coupon = findCouponById(db, payload.couponId ?? payload.id);
    if (!coupon) {
      throw new HttpError(404, "Buono non trovato.", {
        code: "COMMERCIAL_BENEFIT_COUPON_NOT_FOUND",
      });
    }
    const allowedStatuses = new Set(["active", "disabled", "redeemed", "partially_redeemed"]);
    const status = normalizeText(payload.status ?? coupon.status, 40).toLowerCase();
    coupon.status = allowedStatuses.has(status) ? status : coupon.status;
    coupon.unlimitedUsage = payload.unlimitedUsage === true;
    coupon.maxUsageCount = coupon.unlimitedUsage ? 0 : Math.max(1, normalizeCents(payload.maxUsageCount ?? coupon.maxUsageCount ?? 1));
    if (payload.balanceCents != null || payload.balance != null) {
      coupon.balanceCents = normalizeCents(payload.balanceCents ?? Math.round((Number(payload.balance) || 0) * 100));
      if (coupon.benefitKind === COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER && coupon.balanceCents > 0 && coupon.status === "redeemed") {
        coupon.status = "partially_redeemed";
      }
    }
    coupon.updatedAt = nowIso();
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "commercial_benefit.coupon_updated",
      entityType: "commercial_benefit_coupon",
      entityId: coupon.id,
      payload: {
        couponId: coupon.id,
        campaignId: coupon.campaignId,
        status: coupon.status,
        balanceCents: coupon.balanceCents,
      },
    });
    if (!db.meta || typeof db.meta !== "object") db.meta = {};
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    return {
      ok: true,
      campaign: publicCampaignResource(db, findCampaign(db, coupon.campaignId)),
    };
  }

  async function printCoupon(payload, authContext) {
    const db = await readDb();
    const { user, session } = authContext?.user ? authContext : validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    if (typeof enqueuePrintSpoolJob !== "function") {
      throw new HttpError(503, "Coda stampa non disponibile.", {
        code: "COMMERCIAL_BENEFIT_PRINT_UNAVAILABLE",
      });
    }
    const coupon = findCouponById(db, payload.couponId ?? payload.id);
    if (!coupon) {
      throw new HttpError(404, "Buono non trovato.", {
        code: "COMMERCIAL_BENEFIT_COUPON_NOT_FOUND",
      });
    }
    const campaign = findCampaign(db, coupon.campaignId);
    if (!campaign) {
      throw new HttpError(404, "Campagna beneficio non trovata.", {
        code: "COMMERCIAL_BENEFIT_CAMPAIGN_NOT_FOUND",
      });
    }
    const now = nowIso();
    const printerId =
      normalizeText(payload.printerId, 120) ||
      resolveDefaultBenefitPrinterId(db.posSettings);
    const printJob = await enqueuePrintSpoolJob({
      kind: "commercial_benefit_receipt",
      printerId,
      printerPurpose: "generic",
      text: buildCommercialBenefitPrintText({
        campaign,
        coupon,
        options: {
          omitAmount: payload.omitAmount === true,
          qrOnly: payload.qrOnly === true,
        },
        now,
      }),
      userId: user?.id,
      deviceUuid: session?.deviceUuid ?? payload.deviceUuid,
      clientApp: payload.clientApp ?? "settings-frontend",
    });
    const latestDb = await readDb();
    ensureCommercialBenefitCollections(latestDb);
    appendAuditEvent(latestDb, {
      ...buildAuditActor(user, payload),
      action: "commercial_benefit.coupon_printed",
      entityType: "commercial_benefit_coupon",
      entityId: coupon.id,
      payload: {
        couponId: coupon.id,
        campaignId: campaign.id,
        printJobId: printJob.id,
        printerId,
        omitAmount: payload.omitAmount === true,
        qrOnly: payload.qrOnly === true,
      },
    });
    if (!latestDb.meta || typeof latestDb.meta !== "object") latestDb.meta = {};
    latestDb.meta.lastWriteAt = nowIso();
    await writeDb(latestDb);
    return {
      ok: true,
      printJob: {
        id: printJob.id,
        status: printJob.status,
        printerId: printJob.printerId,
        printerName: printJob.printerName,
      },
    };
  }

  async function validateBenefit(payload, authContext) {
    const db = await readDb();
    const { user, session } = authContext?.user ? authContext : validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    const source = normalizeAcquisitionSource(payload.source ?? payload.acquisitionSource);
    const token = resolveBenefitAcquisitionToken(payload, source);
    const payableCents = normalizeCents(
      payload.payableCents ??
        payload.payableBeforeCents ??
        payload.amountCents ??
        Math.round((Number(payload.amount) || 0) * 100),
    );
    const coupon = findCoupon(db, source, token);
    if (!coupon) {
      throw new HttpError(404, "Buono o sconto non trovato.", {
        code: "COMMERCIAL_BENEFIT_NOT_FOUND",
      });
    }
    const requestedClientApplicationId = normalizeText(payload.clientApplicationId, 120);
    const requestDeviceUuid = normalizeText(session.deviceUuid ?? payload.deviceUuid, 160);
    const reusableCoupon = isCommercialBenefitCouponReusable(coupon);
    const activeReservation = reusableCoupon
      ? activeReservationForReusableCoupon(
          db,
          coupon.id,
          requestedClientApplicationId,
          requestDeviceUuid,
        )
      : activeReservationForCoupon(db, coupon.id);
    const sameReservationOwner =
      activeReservation &&
      requestedClientApplicationId &&
      requestDeviceUuid &&
      activeReservation.clientApplicationId === requestedClientApplicationId &&
      normalizeText(activeReservation.deviceUuid, 160) === requestDeviceUuid;
    if (
      activeReservation &&
      !sameReservationOwner &&
      !reusableCoupon
    ) {
      throw new HttpError(409, "Buono gia riservato da un'altra operazione.", {
        code: "COMMERCIAL_BENEFIT_ALREADY_RESERVED",
        details: {
          applicationId: activeReservation.id,
          deviceUuid: normalizeText(activeReservation.deviceUuid, 160) || null,
        },
      });
    }
    if (sameReservationOwner) {
      return { ok: true, application: buildPublicApplication(activeReservation), idempotent: true };
    }

    const campaign = findCampaign(db, coupon.campaignId);
    const calculation = calculateCommercialBenefitApplication({
      campaign,
      coupon,
      payableCents,
      now: nowIso(),
    });
    if (!calculation.ok) {
      throw new HttpError(409, calculation.message || "Beneficio non applicabile.", {
        code: calculation.code || "COMMERCIAL_BENEFIT_NOT_APPLICABLE",
        details: calculation,
      });
    }

    const now = nowIso();
    const reservationTtlMs = Math.max(30_000, Math.min(30 * 60_000, Number(payload.reservationTtlMs) || 10 * 60_000));
    const application = {
      id: requestedClientApplicationId || compactId("cb_app"),
      clientApplicationId: requestedClientApplicationId || null,
      campaignId: campaign.id,
      couponId: coupon.id,
      title: campaign.title,
      benefitKind: campaign.benefitKind,
      residualPolicy: calculation.residualPolicy ?? campaign.residualPolicy ?? null,
      acquisitionSource: source,
      codeMasked: coupon.codeMasked ?? maskCommercialBenefitCode(coupon.code),
      status: COMMERCIAL_BENEFIT_APPLICATION_STATUS.RESERVED,
      payableBeforeCents: calculation.payableBeforeCents,
      payableAfterCents: calculation.payableAfterCents,
      benefitAmountCents: calculation.benefitAmountCents,
      balanceBeforeCents: calculation.balanceBeforeCents ?? 0,
      balanceAfterPreviewCents: calculation.balanceAfterCents ?? 0,
      forfeitedPreviewCents: calculation.forfeitedCents ?? 0,
      couponStatusAfter: calculation.couponStatusAfter ?? "redeemed",
      tableId: normalizeText(payload.tableId, 120) || null,
      orderId: normalizeText(payload.orderId, 120) || null,
      roomId: normalizeText(payload.roomId, 120) || null,
      createdByUserId: user.id,
      createdByUsername: user.username,
      deviceUuid: requestDeviceUuid || null,
      nativeReadId: normalizeText(payload.nativeReadId, 160) || null,
      nativeReadAt: normalizeText(payload.nativeReadAt, 40) || null,
      readerSessionId: normalizeText(payload.readerSessionId, 160) || null,
      createdAt: now,
      updatedAt: now,
      reservationExpiresAt: new Date(Date.parse(now) + reservationTtlMs).toISOString(),
    };
    db.commercialBenefitApplications.push(application);
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "commercial_benefit.reserved",
      entityType: "commercial_benefit_application",
      entityId: application.id,
      roomId: application.roomId,
      payload: {
        applicationId: application.id,
        campaignId: application.campaignId,
        couponId: application.couponId,
        benefitAmountCents: application.benefitAmountCents,
        payableBeforeCents: application.payableBeforeCents,
        payableAfterCents: application.payableAfterCents,
        acquisitionSource: application.acquisitionSource,
        deviceUuid: application.deviceUuid,
        readerSessionId: application.readerSessionId,
        nativeReadId: application.nativeReadId,
      },
    });
    if (!db.meta || typeof db.meta !== "object") db.meta = {};
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    return { ok: true, application: buildPublicApplication(application) };
  }

  async function releaseBenefit(payload, authContext) {
    const db = await readDb();
    const { user } = authContext?.user ? authContext : validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    const applicationId = normalizeCommercialBenefitApplicationRef(payload.applicationId ?? payload);
    const application = findApplication(db, applicationId);
    if (!application) {
      return { ok: true, released: false, reason: "not_found" };
    }
    if (application.status === COMMERCIAL_BENEFIT_APPLICATION_STATUS.RESERVED) {
      application.status = COMMERCIAL_BENEFIT_APPLICATION_STATUS.RELEASED;
      application.releasedAt = nowIso();
      application.updatedAt = application.releasedAt;
      appendAuditEvent(db, {
        ...buildAuditActor(user, payload),
        action: "commercial_benefit.released",
        entityType: "commercial_benefit_application",
        entityId: application.id,
        roomId: application.roomId,
        payload: {
          applicationId: application.id,
          campaignId: application.campaignId,
          couponId: application.couponId,
        },
      });
      if (!db.meta || typeof db.meta !== "object") db.meta = {};
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }
    return { ok: true, released: application.status === COMMERCIAL_BENEFIT_APPLICATION_STATUS.RELEASED };
  }

  return {
    createCampaign,
    updateCampaign,
    updateCoupon,
    printCoupon,
    validateBenefit,
    releaseBenefit,
  };
}
