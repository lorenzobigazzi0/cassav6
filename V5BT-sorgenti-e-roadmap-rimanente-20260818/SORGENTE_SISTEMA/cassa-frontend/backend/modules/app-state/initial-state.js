import { cloneDefaultPosSettings } from "../../lib/pos-defaults.js";
import { DEFAULT_MENU_ITEMS } from "../menu/default-menu-catalog.js";

export { DEFAULT_MENU_ITEMS };

export const DEFAULT_SALE_SESSION_TEMPLATES = [
  {
    id: "tpl_morning",
    name: "Turno Mattina",
    startTime: "09:00",
    endTime: "17:00",
    enabled: true,
  },
  {
    id: "tpl_evening",
    name: "Turno Serale",
    startTime: "17:00",
    endTime: "02:00",
    enabled: true,
  },
];

export const DEFAULT_SMART_CUSTOMERS = [];

// Le postazioni operative non sono più un seed statico: vengono lette da
// posSettings.workstations, così modifiche in Impostazioni diventano runtime.
export const INTEGRATION_STATIONS = [];
export const PRIMARY_INTEGRATION_STATION = "";

function nowIso() {
  return new Date().toISOString();
}

export function shouldSeedDemoData() {
  return false;
}

function buildInitialPosSettings(seedDemoData) {
  const settings = cloneDefaultPosSettings();
  if (seedDemoData) {
    return settings;
  }

  settings.tables = (Array.isArray(settings.tables) ? settings.tables : []).map((table) => ({
    ...table,
    status: "free",
    guestName: "",
    covers: 0,
    totalDue: 0,
    reservation: null,
  }));
  return settings;
}

export function createDefaultIntegrationState(createdAt = nowIso()) {
  const nowMs = Date.now();
  return {
    orders: [],
    barChargeReplacements: [],
    orderComps: [],
    orderCorrections: [],
    orderCorrectionRequests: [],
    orderFulfillmentHistory: [],
    fulfillmentAnomalyStats: {
      global: { total: 0, anomalies: 0 },
      byStation: {},
      byUser: {},
      byStationUser: {},
    },
    notifications: [],
    waiterPauses: [],
    waiterDeferredCalls: [],
    noActiveStationsAlert: {
      active: false,
      notifiedAtMs: 0,
      recoveredAtMs: 0,
    },
    recentBellClaims: [],
    itemAvailability: {},
    tableGroups: [],
    stationStates: INTEGRATION_STATIONS.map((station) => ({
      station,
      active: false,
      autoPrintOrders: false,
      autoPrintPreconto: false,
      operatorUserId: "",
      operatorUsername: "",
      operatorName: "Guest",
      operatorRole: "Non autenticato",
      deviceUuid: "",
      clientApp: "postazione",
      updatedAtMs: nowMs,
      realStation: false,
      isDemoFallback: true,
      stale: false,
    })),
    sequence: {
      order: 1,
      notification: 1,
    },
    lastWriteAt: createdAt,
  };
}

export function buildInitialAppState(options = {}) {
  const createdAt = String(options.createdAt ?? nowIso());
  const seedDemoData = options.seedDemoData ?? shouldSeedDemoData();

  return {
    users: [],
    userGroups: [],
    sessions: [],
    saleSessionTemplates: DEFAULT_SALE_SESSION_TEMPLATES.map((template) => ({
      ...template,
      createdByUserId: "system",
      createdAt,
      updatedAt: createdAt,
    })),
    menuItems: DEFAULT_MENU_ITEMS.map((item) => ({
      ...item,
      createdByUserId: "system",
      createdAt,
      updatedAt: createdAt,
    })),
    posSettings: buildInitialPosSettings(seedDemoData),
    payments: [],
    paymentContainers: [],
    paymentParts: [],
    paymentTransactions: [],
    paymentProviderTransactions: [],
    cashTxDenoms: [],
    handheldCashSessions: [],
    commercialBenefitCampaigns: [],
    commercialBenefitCoupons: [],
    commercialBenefitApplications: [],
    commercialBenefitRedemptions: [],
    fiscalReceipts: [],
    fiscalEvents: [],
    printSpoolJobs: [],
    smartNonFiscal: [],
    auditEvents: [],
    smartCustomers: seedDemoData
      ? DEFAULT_SMART_CUSTOMERS.map((customer) => ({
          ...customer,
          passes: [],
          accessLog: [],
          transactions: [],
          createdAt,
          updatedAt: createdAt,
        }))
      : [],
    integration: createDefaultIntegrationState(createdAt),
    posRoomChangeRequests: [],
    posTableRoomMoveRequests: [],
    posReservationStates: [],
    posReservationLocks: [],
    saleSessions: [],
    solarClosures: [],
    meta: {
      lastWriteAt: createdAt,
      settingsLastWriteAt: createdAt,
      crypto: {
        pinHash: "scrypt",
        sessionTokenHash: "hmac-sha256",
      },
    },
  };
}
