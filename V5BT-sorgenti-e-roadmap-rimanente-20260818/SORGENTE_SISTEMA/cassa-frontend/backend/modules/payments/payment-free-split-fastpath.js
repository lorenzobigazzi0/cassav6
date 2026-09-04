const PAYMENT_FREE_SPLIT_RECORD_WRITE_SPLIT_DOMAINS = [
  "payments",
  "paymentContainers",
  "paymentParts",
  "paymentTransactions",
  "paymentProviderTransactions",
  "cashTxDenoms",
  "fiscalReceipts",
  "fiscalEvents",
  "commercialBenefitApplications",
  "commercialBenefitRedemptions",
];
const PAYMENT_FREE_SPLIT_DEFERRED_MIRROR_SPLIT_DOMAINS = [
  ...PAYMENT_FREE_SPLIT_RECORD_WRITE_SPLIT_DOMAINS,
  "integration",
  "posSettings",
  "auditEvents",
];

function normalizeIds(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) =>
          value && typeof value === "object" ? (value.id ?? value.orderId) : value,
        )
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeCollectionEntryIds(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    PAYMENT_FREE_SPLIT_RECORD_WRITE_SPLIT_DOMAINS
      .map((domain) => [domain, normalizeIds(source[domain])])
      .filter(([, entryIds]) => entryIds.length > 0),
  );
}

export function createPaymentFreeSplitFastPath({
  dbMode,
  mysqlAppStateDomainsSplitRepository,
  atomicSelectionWriter,
  syncPosSettingsTablesFastPath,
  syncOrderAuditEventsFastPath,
  syncSecondaryAuditEventsFastPath,
  writePaymentDb,
  deferTransientMirror,
  runtimeMetrics,
  namedLockCoordinator,
} = {}) {
  return async function writePaymentFreeSplitDb(db, options = {}) {
    if (namedLockCoordinator?.enabled === true && options.namedLockHeld !== true) {
      return namedLockCoordinator.run(
        "paymentDomain",
        () => writePaymentFreeSplitDb(db, { ...options, namedLockHeld: true }),
        { priority: options.namedLockPriority },
      );
    }
    const startedAt = Date.now();
    const metricLabel =
      options.metricLabel ?? "payments.freeSplit.complete.appStateWrite";
    const orderIds = normalizeIds(options.orderIds);
    const tableIds = normalizeIds(options.tableIds);
    const auditEventIds = normalizeIds(options.auditEventIds);
    const collectionEntryIds = normalizeCollectionEntryIds(options.collectionEntryIds);
    const paymentDomainEntries = Object.entries(collectionEntryIds).map(
      ([domain, entryIds]) => ({ domain, entryIds }),
    );
    const skipPosSettingsTables = options.skipPosSettingsTables === true;
    const recordStep = async (label, action) => {
      const stepStartedAt = Date.now();
      try {
        return await action();
      } finally {
        runtimeMetrics?.recordOperation?.(
          "paymentWorkflowStep",
          `payments.freeSplit.${label}`,
          Date.now() - stepStartedAt,
        );
      }
    };
    const canSyncPunctual =
      dbMode === "mysql" &&
      mysqlAppStateDomainsSplitRepository?.enabled === true &&
      typeof mysqlAppStateDomainsSplitRepository
        .syncObjectArrayEntriesAndObjectEntriesFromAppState === "function";
    const canSyncPaymentEntries =
      dbMode === "mysql" &&
      mysqlAppStateDomainsSplitRepository?.enabled === true &&
      paymentDomainEntries.length > 0 &&
      (typeof mysqlAppStateDomainsSplitRepository.syncSelectedEntriesFromAppState ===
        "function" ||
        typeof mysqlAppStateDomainsSplitRepository.syncDomainArrayEntriesFromAppState ===
          "function");
    const canSyncAtomicMirror =
      dbMode === "mysql" &&
      atomicSelectionWriter?.enabled === true &&
      typeof atomicSelectionWriter.write === "function" &&
      typeof syncSecondaryAuditEventsFastPath === "function" &&
      auditEventIds.length > 0 &&
      paymentDomainEntries.length > 0;
    const paymentWriteOptions = {
      ...options,
      metricLabel,
      splitDomains: PAYMENT_FREE_SPLIT_RECORD_WRITE_SPLIT_DOMAINS,
    };
    try {
      let atomicMirrorWritten = false;
      if (canSyncAtomicMirror) {
        try {
          const result = await recordStep("mysql.atomicMirror", () =>
            atomicSelectionWriter.write(db, {
              metricLabel: "paymentFreeSplit.atomicMirror",
              domainSelection: {
                domainArrayEntries: paymentDomainEntries,
                objectArrayEntries:
                  orderIds.length > 0
                    ? [
                        {
                          domain: "integration",
                          fieldName: "orders",
                          entryIds: orderIds,
                        },
                      ]
                    : [],
                objectFields:
                  orderIds.length > 0
                    ? [
                        {
                          domain: "integration",
                          fieldNames: ["lastWriteAt"],
                        },
                      ]
                    : [],
              },
              auditEventIds,
              preserveNewerIntegrationRecords: true,
              preserveNewerPaymentMirrorRecords: true,
            }),
          );
          atomicMirrorWritten = result?.written === true;
          if (atomicMirrorWritten) {
            runtimeMetrics?.incrementCounter?.("paymentFreeSplitAtomicMirrorWrites");
          } else {
            runtimeMetrics?.incrementCounter?.(
              "paymentFreeSplitAtomicMirrorFallbacks",
            );
          }
        } catch (error) {
          runtimeMetrics?.incrementCounter?.("paymentFreeSplitAtomicMirrorErrors");
          throw error;
        }
      }

      if (!atomicMirrorWritten && canSyncPunctual) {
        if (orderIds.length > 0) {
          await recordStep("mysql.integrationBulk", () =>
            mysqlAppStateDomainsSplitRepository.syncObjectArrayEntriesAndObjectEntriesFromAppState(
              db,
              "integration",
              {
                objectArrayEntries: [
                  { fieldName: "orders", entryIds: orderIds },
                ],
                objectFields: ["lastWriteAt"],
                preserveNewerIntegrationRecords: true,
              },
            ),
          );
        }
        if (tableIds.length > 0 && !skipPosSettingsTables) {
          await recordStep("mysql.posSettingsTables", () =>
            syncPosSettingsTablesFastPath(db, tableIds),
          );
        } else if (tableIds.length > 0) {
          runtimeMetrics?.incrementCounter?.("paymentMirrorPosSettingsTablesSkipped");
        }
        await recordStep("audit", () =>
          syncOrderAuditEventsFastPath(db, auditEventIds),
        );
      }
      if (!atomicMirrorWritten && canSyncPaymentEntries) {
        if (typeof mysqlAppStateDomainsSplitRepository.syncSelectedEntriesFromAppState === "function") {
          await recordStep("mysql.paymentRecords.batch", () =>
            mysqlAppStateDomainsSplitRepository.syncSelectedEntriesFromAppState(
              db,
              {
                domainArrayEntries: paymentDomainEntries,
              },
              {
                metricPrefix: "paymentFreeSplit.records",
                preserveNewerPaymentMirrorRecords: true,
              },
            ),
          );
        } else {
          for (const { domain, entryIds } of paymentDomainEntries) {
            await recordStep(`mysql.paymentRecords.${domain}`, () =>
              mysqlAppStateDomainsSplitRepository.syncDomainArrayEntriesFromAppState(
                db,
                domain,
                entryIds,
              ),
            );
          }
        }
        runtimeMetrics?.incrementCounter?.("paymentFreeSplitPunctualMirrorWrites");
      } else if (!atomicMirrorWritten) {
        await recordStep("paymentRecords", () =>
          writePaymentDb(db, paymentWriteOptions),
        );
      } else {
        await recordStep("audit.secondary", () =>
          syncSecondaryAuditEventsFastPath(db, auditEventIds),
        );
        if (tableIds.length > 0 && !skipPosSettingsTables) {
          await recordStep("mysql.posSettingsTables", () =>
            syncPosSettingsTablesFastPath(db, tableIds),
          );
        } else if (tableIds.length > 0) {
          runtimeMetrics?.incrementCounter?.("paymentMirrorPosSettingsTablesSkipped");
        }
      }
    } catch (error) {
      const deferred = await deferTransientMirror?.(
        error,
        db,
        {
          ...paymentWriteOptions,
          splitDomains: PAYMENT_FREE_SPLIT_DEFERRED_MIRROR_SPLIT_DOMAINS,
        },
      );
      if (!deferred) throw error;
      runtimeMetrics?.incrementCounter?.(
        "paymentFreeSplitTransientMirrorDeferred",
      );
    }
    runtimeMetrics?.recordOperation?.(
      "paymentWorkflow",
      metricLabel,
      Date.now() - startedAt,
    );
  };
}
