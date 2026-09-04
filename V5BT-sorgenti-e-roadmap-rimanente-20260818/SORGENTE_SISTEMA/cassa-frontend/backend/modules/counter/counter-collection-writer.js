const FALLBACK_SPLIT_DOMAINS = [
  "payments",
  "paymentContainers",
  "paymentParts",
  "paymentTransactions",
  "cashTxDenoms",
  "commercialBenefitCampaigns",
  "commercialBenefitCoupons",
  "commercialBenefitApplications",
  "commercialBenefitRedemptions",
  "auditEvents",
];

function normalizeIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function domainEntry(domain, entryIds) {
  const ids = normalizeIds(entryIds);
  return ids.length > 0 ? { domain, entryIds: ids } : null;
}

export function createCounterCollectionWriter(options = {}) {
  const enabled = options.enabled === true;
  const atomicSelectionWriter = options.atomicSelectionWriter;
  const writeDb = options.writeDb;
  const runtimeMetrics = options.runtimeMetrics;
  const namedLockCoordinator = options.namedLockCoordinator;

  async function writeFallback(db) {
    runtimeMetrics?.incrementCounter?.("counterCollectionAtomicFallbacks");
    return writeDb(db, {
      metricLabel: "counter.collect.appStateWrite",
      splitDomains: FALLBACK_SPLIT_DOMAINS,
    });
  }

  return async function writeCounterCollection(db, mutation = {}) {
    if (namedLockCoordinator?.enabled === true && mutation.namedLockHeld !== true) {
      return namedLockCoordinator.run("paymentDomain", () =>
        writeCounterCollection(db, { ...mutation, namedLockHeld: true }));
    }
    const startedAt = Date.now();
    const canUseAtomicWriter =
      enabled && typeof atomicSelectionWriter?.write === "function";
    if (!canUseAtomicWriter) return writeFallback(db);

    const domainArrayEntries = [
      domainEntry("payments", mutation.paymentIds),
      domainEntry("paymentContainers", mutation.paymentContainerIds),
      domainEntry("paymentParts", mutation.paymentPartIds),
      domainEntry("paymentTransactions", mutation.paymentTransactionIds),
      domainEntry("cashTxDenoms", mutation.cashTxDenomIds),
      domainEntry(
        "commercialBenefitCampaigns",
        mutation.commercialBenefitCampaignIds,
      ),
      domainEntry(
        "commercialBenefitCoupons",
        mutation.commercialBenefitCouponIds,
      ),
      domainEntry(
        "commercialBenefitApplications",
        mutation.commercialBenefitApplicationIds,
      ),
      domainEntry(
        "commercialBenefitRedemptions",
        mutation.commercialBenefitRedemptionIds,
      ),
    ].filter(Boolean);
    let result;
    try {
      result = await atomicSelectionWriter.write(db, {
        metricLabel: "counter.collect.atomic",
        domainSelection: { domainArrayEntries },
        auditEventIds: normalizeIds(mutation.auditEventIds),
      });
    } catch (error) {
      runtimeMetrics?.incrementCounter?.("counterCollectionAtomicErrors");
      throw error;
    }
    if (!result?.written) return writeFallback(db);

    runtimeMetrics?.incrementCounter?.("counterCollectionAtomicWrites");
    runtimeMetrics?.recordOperation?.(
      "counterCollectionWriter",
      "atomic",
      Date.now() - startedAt,
    );
    return result;
  };
}

export { FALLBACK_SPLIT_DOMAINS as COUNTER_COLLECTION_WRITE_DOMAINS };
