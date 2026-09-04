import assert from "node:assert/strict";
import test from "node:test";
import { buildRouteRegistry } from "../routes/index.js";
import {
  COMMERCIAL_BENEFIT_KINDS,
  VALUE_VOUCHER_RESIDUAL_POLICIES,
  calculateCommercialBenefitApplication,
  createCommercialBenefitCampaign,
  createCommercialBenefitsHandlers,
  createCommercialBenefitsReadModel,
  createCommercialBenefitsWriteModel,
  redeemCommercialBenefitApplications,
} from "../modules/commercial-benefits/index.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = options.code;
    this.details = options.details;
  }
}

function buildCampaignAndCoupon(residualPolicy) {
  const result = createCommercialBenefitCampaign(
    {
      title: "Buono Test 20",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER,
      faceValueCents: 2000,
      residualPolicy,
      codes: ["ABCD-EFGH-IJKL"],
      validFrom: "2026-06-29T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
    },
    {
      now: "2026-06-29T10:00:00.000Z",
      idFactory(prefix) {
        return `${prefix}_test`;
      },
    },
  );
  assert.equal(result.ok, true);
  return { campaign: result.campaign, coupon: result.coupons[0] };
}

function createHarness({ db, payload, user = { id: "u1", username: "admin" } }) {
  let response = null;
  let writeCount = 0;
  const printJobs = [];
  let currentPayload = payload;
  const modelloDipendenze = {
    HttpError: TestHttpError,
    appendAuditEvent(target, event) {
      if (!Array.isArray(target.auditEvents)) target.auditEvents = [];
      target.auditEvents.push(event);
    },
    buildAuditActor(candidate) {
      return {
        userId: candidate?.id ?? "u1",
        username: candidate?.username ?? "admin",
      };
    },
    async enqueuePrintSpoolJob(job) {
      const printJob = {
        id: `print_${printJobs.length + 1}`,
        status: "disabled",
        printerId: job.printerId ?? "",
        printerName: "Test printer",
        textPreview: job.text,
      };
      printJobs.push(printJob);
      return printJob;
    },
    nowIso() {
      return "2026-06-29T10:00:00.000Z";
    },
    async readDb() {
      return db;
    },
    validateSessionContext() {
      return {
        user,
        session: { deviceUuid: currentPayload.deviceUuid ?? "tablet-1" },
      };
    },
    async writeDb(nextDb) {
      db = nextDb;
      writeCount += 1;
    },
  };

  const { listCampaignsView } = createCommercialBenefitsReadModel(modelloDipendenze);
  const modelloScrittura = createCommercialBenefitsWriteModel(modelloDipendenze);
  const handlers = createCommercialBenefitsHandlers({
    createCampaign: modelloScrittura.createCampaign,
    listCampaignsView,
    printCoupon: modelloScrittura.printCoupon,
    async readJsonBody() {
      return currentPayload;
    },
    releaseBenefit: modelloScrittura.releaseBenefit,
    sendJson(_res, status, body) {
      response = { status, body };
    },
    updateCampaign: modelloScrittura.updateCampaign,
    updateCoupon: modelloScrittura.updateCoupon,
    validateBenefit: modelloScrittura.validateBenefit,
  });

  return {
    handlers,
    set payload(nextPayload) {
      currentPayload = nextPayload;
    },
    get db() {
      return db;
    },
    get response() {
      return response;
    },
    get writeCount() {
      return writeCount;
    },
    get printJobs() {
      return printJobs;
    },
  };
}

test("creazione buono valore richiede residualPolicy e la copia sui coupon emessi", () => {
  const invalid = createCommercialBenefitCampaign({
    title: "Buono senza policy",
    benefitKind: COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER,
    faceValueCents: 1000,
    codes: ["AAAA-BBBB-CCCC"],
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.some((error) => error.field === "residualPolicy"), true);

  const { campaign, coupon } = buildCampaignAndCoupon(
    VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
  );
  assert.equal(campaign.residualPolicy, VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE);
  assert.equal(coupon.residualPolicy, VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE);
  assert.equal(coupon.balanceCents, 2000);
});

test("forfeit_remaining consuma il residuo non usato", () => {
  const { campaign, coupon } = buildCampaignAndCoupon(
    VALUE_VOUCHER_RESIDUAL_POLICIES.FORFEIT_REMAINING,
  );
  const calculation = calculateCommercialBenefitApplication({
    campaign,
    coupon,
    payableCents: 1200,
    now: "2026-06-29T10:00:00.000Z",
  });
  assert.equal(calculation.ok, true);
  assert.equal(calculation.benefitAmountCents, 1200);
  assert.equal(calculation.balanceAfterCents, 0);
  assert.equal(calculation.forfeitedCents, 800);
  assert.equal(calculation.couponStatusAfter, "redeemed");
});

test("keep_balance mantiene il saldo residuo", () => {
  const { campaign, coupon } = buildCampaignAndCoupon(
    VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
  );
  const calculation = calculateCommercialBenefitApplication({
    campaign,
    coupon,
    payableCents: 1200,
    now: "2026-06-29T10:00:00.000Z",
  });
  assert.equal(calculation.ok, true);
  assert.equal(calculation.benefitAmountCents, 1200);
  assert.equal(calculation.balanceAfterCents, 800);
  assert.equal(calculation.forfeitedCents, 0);
  assert.equal(calculation.couponStatusAfter, "partially_redeemed");
});

test("no_partial_use rifiuta importi inferiori al saldo buono", () => {
  const { campaign, coupon } = buildCampaignAndCoupon(
    VALUE_VOUCHER_RESIDUAL_POLICIES.NO_PARTIAL_USE,
  );
  const calculation = calculateCommercialBenefitApplication({
    campaign,
    coupon,
    payableCents: 1200,
    now: "2026-06-29T10:00:00.000Z",
  });
  assert.equal(calculation.ok, false);
  assert.equal(calculation.code, "partial_use_not_allowed");
});

test("sconto percentuale riutilizzabile resta attivo dopo il riscatto", () => {
  const result = createCommercialBenefitCampaign(
    {
      title: "Sconto sempre valido",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT,
      percentageBps: 10000,
      maxUsageCount: 0,
      unlimitedUsage: true,
      codes: ["SCON-TO10-0000"],
      validFrom: "2026-06-29T00:00:00.000Z",
    },
    {
      now: "2026-06-29T10:00:00.000Z",
      idFactory(prefix) {
        return `${prefix}_reusable`;
      },
    },
  );
  assert.equal(result.ok, true);

  const [coupon] = result.coupons;
  assert.equal(coupon.maxUsageCount, 0);
  assert.equal(coupon.unlimitedUsage, true);

  const calculation = calculateCommercialBenefitApplication({
    campaign: result.campaign,
    coupon: { ...coupon, usageCount: 15, status: "active" },
    payableCents: 1234,
    now: "2026-06-29T10:00:00.000Z",
  });

  assert.equal(calculation.ok, true);
  assert.equal(calculation.benefitAmountCents, 1234);
  assert.equal(calculation.payableAfterCents, 0);
  assert.equal(calculation.couponStatusAfter, "active");
});

test("NFC e QR possono trasmettere direttamente un codice sconto commerciale", async () => {
  for (const source of ["nfc", "qr"]) {
    const result = createCommercialBenefitCampaign(
      {
        title: "Sconto codice su canale elettronico",
        benefitKind: COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT,
        percentageBps: 1000,
        maxUsageCount: 0,
        unlimitedUsage: true,
        codes: ["SCON-TO10-0000"],
        validFrom: "2026-06-29T00:00:00.000Z",
      },
      {
        now: "2026-06-29T10:00:00.000Z",
        idFactory(prefix) {
          return `${prefix}_${source}_code_fallback`;
        },
      },
    );
    assert.equal(result.ok, true);

    const harness = createHarness({
      db: {
        commercialBenefitCampaigns: [result.campaign],
        commercialBenefitCoupons: result.coupons,
        commercialBenefitApplications: [],
        commercialBenefitRedemptions: [],
        auditEvents: [],
        meta: {},
      },
      payload: {
        token: "session-token",
        source,
        ...(source === "nfc"
          ? { nfcToken: "SCON-TO10-0000" }
          : { qrPayload: "SCON-TO10-0000" }),
        payableBeforeCents: 1234,
        tableId: "table_1",
        deviceUuid: "tablet-1",
      },
    });

    await harness.handlers["commercialBenefits.validate"]({}, {});

    assert.equal(harness.response.status, 200);
    assert.equal(harness.response.body.ok, true);
    assert.equal(harness.response.body.application.acquisitionSource, source);
    assert.equal(harness.response.body.application.codeMasked, "SCON-****-0000");
    assert.equal(harness.response.body.application.benefitAmountCents, 123);
  }
});

test("route registry espone gli endpoint commercial-benefits", () => {
  const routes = buildRouteRegistry().filter((route) =>
    String(route.path ?? "").includes("/commercial-benefits"),
  );
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path} -> ${route.handlerKey}`),
    [
      "POST /api/commercial-benefits/campaigns/list -> commercialBenefits.listCampaigns",
      "POST /api/commercial-benefits/campaigns -> commercialBenefits.createCampaign",
      "POST /api/commercial-benefits/campaigns/update -> commercialBenefits.updateCampaign",
      "POST /api/commercial-benefits/coupons/update -> commercialBenefits.updateCoupon",
      "POST /api/commercial-benefits/print -> commercialBenefits.printCoupon",
      "POST /api/commercial-benefits/validate -> commercialBenefits.validate",
      "POST /api/commercial-benefits/release -> commercialBenefits.release",
    ],
  );
  assert.equal(routes[0].permission, "manage_settings");
  assert.equal(routes[0].mutation, false);
  assert.equal(routes[1].permission, "manage_settings");
});

test("validate riserva un buono e redeem aggiorna saldo/redemption", async () => {
  const { campaign, coupon } = buildCampaignAndCoupon(
    VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
  );
  const harness = createHarness({
    db: {
      commercialBenefitCampaigns: [campaign],
      commercialBenefitCoupons: [coupon],
      commercialBenefitApplications: [],
      commercialBenefitRedemptions: [],
      auditEvents: [],
      meta: {},
    },
    payload: {
      source: "code",
      token: "ABCD EFGH IJKL",
      payableBeforeCents: 1200,
      tableId: "table_1",
      deviceUuid: "tablet-1",
    },
  });

  await harness.handlers["commercialBenefits.validate"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.ok, true);
  assert.equal(harness.response.body.application.benefitAmountCents, 1200);
  assert.equal(harness.db.commercialBenefitApplications.length, 1);
  assert.equal(harness.writeCount, 1);

  const [redeemed] = redeemCommercialBenefitApplications(
    harness.db,
    [harness.response.body.application.id],
    {
      now: "2026-06-29T10:01:00.000Z",
      paymentId: "pay_1",
      user: { id: "u1", username: "admin" },
      session: { deviceUuid: "tablet-1" },
    },
  );

  assert.equal(redeemed.status, "redeemed");
  assert.equal(harness.db.commercialBenefitCoupons[0].balanceCents, 800);
  assert.equal(harness.db.commercialBenefitCoupons[0].status, "partially_redeemed");
  assert.equal(harness.db.commercialBenefitRedemptions.length, 1);
  assert.equal(harness.db.commercialBenefitRedemptions[0].benefitAmountCents, 1200);
});

test("creazione campagna accetta token NFC hashato e validate lo usa", async () => {
  const harness = createHarness({
    db: {
      commercialBenefitCampaigns: [],
      commercialBenefitCoupons: [],
      commercialBenefitApplications: [],
      commercialBenefitRedemptions: [],
      auditEvents: [],
      meta: {},
    },
    payload: {
      title: "Buono NFC 10",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER,
      faceValueCents: 1000,
      residualPolicy: VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
      codes: ["NFC1-TEST-0001"],
      issuance: {
        nfcTokens: ["tag-nfc-alpha"],
      },
      validFrom: "2026-06-29T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      deviceUuid: "tablet-1",
    },
  });

  await harness.handlers["commercialBenefits.createCampaign"]({}, {});

  assert.equal(harness.response.status, 201);
  assert.equal(harness.db.commercialBenefitCoupons.length, 1);
  assert.ok(harness.db.commercialBenefitCoupons[0].nfcTokenHash);
  assert.notEqual(harness.db.commercialBenefitCoupons[0].nfcTokenHash, "tag-nfc-alpha");

  harness.payload = {
    source: "nfc",
    token: "tag-nfc-alpha",
    payableBeforeCents: 900,
    tableId: "table_1",
    deviceUuid: "tablet-1",
  };

  await harness.handlers["commercialBenefits.validate"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.ok, true);
  assert.equal(harness.response.body.application.acquisitionSource, "nfc");
  assert.equal(harness.response.body.application.benefitAmountCents, 900);
});

test("letture NFC concorrenti restano isolate per device", async () => {
  const harness = createHarness({
    db: {
      commercialBenefitCampaigns: [],
      commercialBenefitCoupons: [],
      commercialBenefitApplications: [],
      commercialBenefitRedemptions: [],
      auditEvents: [],
      meta: {},
    },
    payload: {
      title: "Buono NFC concorrenza",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER,
      faceValueCents: 1000,
      residualPolicy: VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
      codes: ["NFC2-TEST-0002"],
      issuance: {
        nfcTokens: ["tag-nfc-shared"],
      },
      validFrom: "2026-06-29T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      deviceUuid: "tablet-1",
    },
  });

  await harness.handlers["commercialBenefits.createCampaign"]({}, {});

  harness.payload = {
    source: "nfc",
    token: "tag-nfc-shared",
    payableBeforeCents: 800,
    tableId: "table_1",
    deviceUuid: "tablet-1",
    clientApplicationId: "cbapp_tablet_1_read_1",
    readerSessionId: "reader_tablet_1",
    nativeReadId: "native_read_1",
    nativeReadAt: 1782300000000,
  };

  await harness.handlers["commercialBenefits.validate"]({}, {});

  const firstApplicationId = harness.response.body.application.id;
  assert.equal(harness.response.body.application.acquisitionSource, "nfc");
  assert.equal(harness.db.commercialBenefitApplications[0].deviceUuid, "tablet-1");
  assert.equal(harness.db.commercialBenefitApplications[0].readerSessionId, "reader_tablet_1");
  harness.db.commercialBenefitApplications[0].reservationExpiresAt =
    new Date(Date.now() + 60_000).toISOString();

  await harness.handlers["commercialBenefits.validate"]({}, {});

  assert.equal(harness.response.body.idempotent, true);
  assert.equal(harness.response.body.application.id, firstApplicationId);

  harness.payload = {
    source: "nfc",
    token: "tag-nfc-shared",
    payableBeforeCents: 800,
    tableId: "table_9",
    deviceUuid: "tablet-2",
    clientApplicationId: "cbapp_tablet_2_read_1",
    readerSessionId: "reader_tablet_2",
    nativeReadId: "native_read_2",
    nativeReadAt: 1782300000100,
  };

  await assert.rejects(
    () => harness.handlers["commercialBenefits.validate"]({}, {}),
    (error) => {
      assert.equal(error.code, "COMMERCIAL_BENEFIT_ALREADY_RESERVED");
      assert.equal(error.status, 409);
      assert.equal(error.details.deviceUuid, "tablet-1");
      return true;
    },
  );
});

test("impostazioni gestiscono campagne regalo e stampa senza importo", async () => {
  const harness = createHarness({
    db: {
      posSettings: {
        printers: [{ id: "printer_bar", name: "Bar", purpose: "generic", active: true }],
      },
      commercialBenefitCampaigns: [],
      commercialBenefitCoupons: [],
      commercialBenefitApplications: [],
      commercialBenefitRedemptions: [],
      auditEvents: [],
      meta: {},
    },
    payload: {
      title: "Gift card prova",
      benefitCategory: "gift_card",
      faceValueCents: 1000,
      residualPolicy: VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
      quantity: 1,
      codes: ["GIFT-TEST-0001"],
      validFrom: "2026-06-29T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      print: {
        omitAmountOnGiftReceipt: true,
        qrOnlyGiftReceipt: true,
      },
    },
  });

  await harness.handlers["commercialBenefits.createCampaign"]({}, {});

  assert.equal(harness.response.status, 201);
  assert.equal(harness.response.body.campaign.benefitCategory, "gift_card");
  assert.equal(harness.response.body.campaign.benefitKind, COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER);
  assert.equal(harness.db.commercialBenefitCoupons.length, 1);

  harness.payload = {
    couponId: harness.db.commercialBenefitCoupons[0].id,
    omitAmount: true,
    qrOnly: true,
    printerId: "printer_bar",
  };

  await harness.handlers["commercialBenefits.printCoupon"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.printJobs.length, 1);
  assert.match(harness.printJobs[0].textPreview, /\{\{ESC_POS_RAW_BASE64:/);
  assert.doesNotMatch(harness.printJobs[0].textPreview, /10,00|10\.00|Valore/i);
});

test("impostazioni aggiornano stato campagna e saldo coupon", async () => {
  const { campaign, coupon } = buildCampaignAndCoupon(
    VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
  );
  const harness = createHarness({
    db: {
      commercialBenefitCampaigns: [campaign],
      commercialBenefitCoupons: [coupon],
      commercialBenefitApplications: [],
      commercialBenefitRedemptions: [],
      auditEvents: [],
      meta: {},
    },
    payload: {
      campaignId: campaign.id,
      title: "Buono Test 20 aggiornato",
      benefitCategory: "voucher",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.VALUE_VOUCHER,
      faceValueCents: 2000,
      residualPolicy: VALUE_VOUCHER_RESIDUAL_POLICIES.KEEP_BALANCE,
      status: "disabled",
      validFrom: campaign.validFrom,
      validUntil: campaign.validUntil,
    },
  });

  await harness.handlers["commercialBenefits.updateCampaign"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.db.commercialBenefitCampaigns[0].status, "disabled");

  harness.payload = {
    couponId: coupon.id,
    status: "active",
    balanceCents: 500,
    maxUsageCount: 2,
  };

  await harness.handlers["commercialBenefits.updateCoupon"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.db.commercialBenefitCoupons[0].balanceCents, 500);
  assert.equal(harness.db.commercialBenefitCoupons[0].maxUsageCount, 2);
});
