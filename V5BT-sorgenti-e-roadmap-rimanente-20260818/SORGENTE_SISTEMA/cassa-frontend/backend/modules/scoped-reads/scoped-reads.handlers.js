import {
  findScopedOpenOrderForTable,
  findScopedPrintJob,
  findScopedTable,
  listScopedNotifications,
  listScopedRoomTables,
  normalizeScopedReadId,
  resolveScopedReadSourceMeta,
} from "./scoped-reads.domain.js";

function requestParam(req, requestUrl, name) {
  return normalizeScopedReadId(
    req?.params?.[name] ?? requestUrl?.searchParams?.get(name),
  );
}

function buildNotificationRequester(requestUrl) {
  const searchParams = requestUrl?.searchParams;
  const consumer = normalizeScopedReadId(searchParams?.get("consumer") || "mobile-frontend");
  return {
    consumer,
    ackConsumer: normalizeScopedReadId(searchParams?.get("ackConsumer") || consumer),
    userId: normalizeScopedReadId(searchParams?.get("userId")),
    username: normalizeScopedReadId(searchParams?.get("username")),
    fullName: normalizeScopedReadId(searchParams?.get("fullName")),
    deviceUuid: normalizeScopedReadId(searchParams?.get("deviceUuid")),
    roomId: normalizeScopedReadId(searchParams?.get("roomId")),
    roomName: String(searchParams?.get("roomName") ?? "").trim(),
    station: String(searchParams?.get("station") ?? "").trim(),
    clientApp: String(searchParams?.get("clientApp") ?? "mobile-frontend").trim(),
  };
}

export function createScopedReadsHandlers(options = {}) {
  const {
    HttpError,
    buildLayoutSnapshot,
    compareNotifications,
    domainsRepository = null,
    isNotificationGloballyAcknowledged,
    logger = console,
    notificationMatchesTarget,
    printSpoolJobsRepository = null,
    readDb,
    redisVolatileStore = null,
    relationalOrderReader = null,
    relationalTableReader = null,
    runtimeMetrics = null,
    sanitizePrintJob = (job) => job,
    sanitizePrintJobs = (jobs) => jobs,
    sanitizeNotification,
    scopedReadsEnabled = false,
    sendJson,
  } = options;

  async function readRedisCache(cacheKind, cacheId) {
    if (!redisVolatileStore?.cacheEnabled) return { hit: false };
    const key = redisVolatileStore.cacheKey(cacheKind, cacheId);
    return await redisVolatileStore.getJson(key);
  }

  async function writeRedisCache(cacheKind, cacheId, value, source) {
    if (!["scoped", "relational"].includes(source) || !redisVolatileStore?.cacheEnabled) return;
    const key = redisVolatileStore.cacheKey(cacheKind, cacheId);
    await redisVolatileStore.setJson(key, value);
  }

  async function readRelationalTableState(tableId) {
    if (!scopedReadsEnabled || !relationalTableReader?.enabled) return null;
    const table = await relationalTableReader.getTable?.(tableId);
    if (!table) return null;
    return { table, source: "relational" };
  }

  async function readRelationalRoomTablesState(roomId) {
    if (!scopedReadsEnabled || !relationalTableReader?.enabled) return null;
    const tables = await relationalTableReader.listRoomTables?.(roomId);
    if (!Array.isArray(tables)) return null;
    return { tables, source: "relational" };
  }

  async function readRelationalOpenOrderState(tableId) {
    if (!scopedReadsEnabled || !relationalOrderReader?.enabled) return null;
    const result = await relationalOrderReader.findOpenOrderForTable?.(tableId);
    if (!result || typeof result !== "object" || !Object.hasOwn(result, "order")) {
      return null;
    }
    return { order: result.order ?? null, source: "relational" };
  }

  async function buildScopedLayoutState() {
    if (!scopedReadsEnabled || !domainsRepository?.enabled) return null;
    try {
      const [posSettings, menuItems, orders, paymentContainers, auditEvents] = await Promise.all([
        domainsRepository.readDomainValue("posSettings", {}),
        domainsRepository.readDomainValue("menuItems", []),
        domainsRepository.readObjectArrayField("integration", "orders", []),
        domainsRepository.readDomainValue("paymentContainers", []),
        domainsRepository.readDomainValue("auditEvents", []),
      ]);
      return {
        posSettings,
        menuItems: Array.isArray(menuItems) ? menuItems : [],
        paymentContainers: Array.isArray(paymentContainers) ? paymentContainers : [],
        auditEvents: Array.isArray(auditEvents) ? auditEvents : [],
        integration: {
          orders: Array.isArray(orders) ? orders : [],
        },
      };
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] layout fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function readScopedOrders() {
    if (!scopedReadsEnabled || !domainsRepository?.enabled) return null;
    try {
      return await domainsRepository.readObjectArrayField("integration", "orders", []);
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] orders fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function readScopedNotifications() {
    if (!scopedReadsEnabled || !domainsRepository?.enabled) return null;
    try {
      return await domainsRepository.readObjectArrayField("integration", "notifications", []);
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] notifications fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function readPrintJob(jobId) {
    if (!scopedReadsEnabled || !printSpoolJobsRepository?.enabled) return null;
    try {
      const job =
        typeof printSpoolJobsRepository.getPrintSpoolJob === "function"
          ? await printSpoolJobsRepository.getPrintSpoolJob(jobId)
          : null;
      return job ? sanitizePrintJob(job, jobId) : null;
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] print job fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function readPrintJobs() {
    if (!scopedReadsEnabled || !printSpoolJobsRepository?.enabled) return null;
    try {
      const jobs = await printSpoolJobsRepository.listPrintSpoolJobs();
      return sanitizePrintJobs(jobs);
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] print jobs fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function readLayoutState() {
    const scopedDb = await buildScopedLayoutState();
    if (scopedDb) {
      return {
        db: scopedDb,
        layout: buildLayoutSnapshot(scopedDb),
        source: "scoped",
      };
    }
    runtimeMetrics?.incrementCounter?.("scopedReadsFullStateFallback");
    const db = await readDb();
    return {
      db,
      layout: buildLayoutSnapshot(db),
      source: "legacy",
    };
  }

  async function readNotificationsState() {
    const scopedNotifications = await readScopedNotifications();
    if (Array.isArray(scopedNotifications)) {
      return { notifications: scopedNotifications, source: "scoped" };
    }
    runtimeMetrics?.incrementCounter?.("scopedReadsFullStateFallback");
    const db = await readDb();
    return {
      notifications: Array.isArray(db?.integration?.notifications)
        ? db.integration.notifications
        : [],
      source: "legacy",
    };
  }

  async function readPrintJobState(jobId) {
    const scopedJob = await readPrintJob(jobId);
    if (scopedJob) return { job: scopedJob, source: "scoped" };
    const scopedJobs = await readPrintJobs();
    if (Array.isArray(scopedJobs)) {
      return {
        job: findScopedPrintJob(scopedJobs, jobId),
        source: "scoped",
      };
    }
    runtimeMetrics?.incrementCounter?.("scopedReadsFullStateFallback");
    const db = await readDb();
    return {
      job: findScopedPrintJob(db?.printSpoolJobs, jobId),
      source: "legacy",
    };
  }

  async function handleScopedTable(req, res, requestUrl) {
    const tableId = requestParam(req, requestUrl, "tableId");
    if (!tableId) throw new HttpError(400, "ID tavolo non valido.");
    const cached = await readRedisCache("table", tableId);
    if (cached.hit) {
      sendJson(res, 200, {
        ok: true,
        table: cached.value,
        meta: resolveScopedReadSourceMeta("redis"),
      });
      return;
    }
    const relationalState = await readRelationalTableState(tableId);
    if (relationalState?.table) {
      await writeRedisCache("table", tableId, relationalState.table, relationalState.source);
      sendJson(res, 200, {
        ok: true,
        table: relationalState.table,
        meta: resolveScopedReadSourceMeta(relationalState.source),
      });
      return;
    }
    const state = await readLayoutState();
    const table = findScopedTable(state.layout, tableId);
    if (!table) throw new HttpError(404, "Tavolo non trovato.");
    await writeRedisCache("table", tableId, table, state.source);
    sendJson(res, 200, {
      ok: true,
      table,
      meta: resolveScopedReadSourceMeta(state.source),
    });
  }

  async function handleScopedTableOpenOrder(req, res, requestUrl) {
    const tableId = requestParam(req, requestUrl, "tableId");
    if (!tableId) throw new HttpError(400, "ID tavolo non valido.");
    const cached = await readRedisCache("table-open-order", tableId);
    if (cached.hit) {
      sendJson(res, 200, {
        ok: true,
        order: cached.value,
        meta: resolveScopedReadSourceMeta("redis"),
      });
      return;
    }
    const relationalState = await readRelationalOpenOrderState(tableId);
    if (relationalState) {
      await writeRedisCache("table-open-order", tableId, relationalState.order, relationalState.source);
      sendJson(res, 200, {
        ok: true,
        order: relationalState.order,
        meta: resolveScopedReadSourceMeta(relationalState.source),
      });
      return;
    }
    const scopedOrders = await readScopedOrders();
    let source = "scoped";
    let orders = scopedOrders;
    if (!Array.isArray(orders)) {
      runtimeMetrics?.incrementCounter?.("scopedReadsFullStateFallback");
      const db = await readDb();
      orders = Array.isArray(db?.integration?.orders) ? db.integration.orders : [];
      source = "legacy";
    }
    const order = findScopedOpenOrderForTable(orders, tableId);
    await writeRedisCache("table-open-order", tableId, order, source);
    sendJson(res, 200, {
      ok: true,
      order,
      meta: resolveScopedReadSourceMeta(source),
    });
  }

  async function handleScopedRoomTables(req, res, requestUrl) {
    const roomId = requestParam(req, requestUrl, "roomId");
    if (!roomId) throw new HttpError(400, "ID sala non valido.");
    const cached = await readRedisCache("room-tables", roomId);
    if (cached.hit) {
      sendJson(res, 200, {
        ok: true,
        roomId,
        tables: Array.isArray(cached.value) ? cached.value : [],
        meta: resolveScopedReadSourceMeta("redis"),
      });
      return;
    }
    const relationalState = await readRelationalRoomTablesState(roomId);
    if (relationalState) {
      await writeRedisCache("room-tables", roomId, relationalState.tables, relationalState.source);
      sendJson(res, 200, {
        ok: true,
        roomId,
        tables: relationalState.tables,
        meta: resolveScopedReadSourceMeta(relationalState.source),
      });
      return;
    }
    const state = await readLayoutState();
    const tables = listScopedRoomTables(state.layout, roomId);
    await writeRedisCache("room-tables", roomId, tables, state.source);
    sendJson(res, 200, {
      ok: true,
      roomId,
      tables,
      meta: resolveScopedReadSourceMeta(state.source),
    });
  }

  async function handleScopedNotifications(_req, res, requestUrl) {
    const state = await readNotificationsState();
    const requester = buildNotificationRequester(requestUrl);
    const items = listScopedNotifications(state.notifications, requester, {
      compareNotifications,
      isGloballyAcknowledged: isNotificationGloballyAcknowledged,
      matchesTarget: notificationMatchesTarget,
      sanitizeNotification,
    });
    sendJson(res, 200, {
      ok: true,
      items,
      meta: resolveScopedReadSourceMeta(state.source),
    });
  }

  async function handleScopedPrintJob(req, res, requestUrl) {
    const jobId = requestParam(req, requestUrl, "jobId");
    if (!jobId) throw new HttpError(400, "ID job stampa non valido.");
    const state = await readPrintJobState(jobId);
    if (!state.job) throw new HttpError(404, "Job stampa non trovato.");
    sendJson(res, 200, {
      ok: true,
      job: state.job,
      meta: resolveScopedReadSourceMeta(state.source),
    });
  }

  return {
    handleScopedNotifications,
    handleScopedPrintJob,
    handleScopedRoomTables,
    handleScopedTable,
    handleScopedTableOpenOrder,
  };
}
