export const DEFAULT_FISCAL_PRINTER_MODEL = "epson_tm_t800f_m261a";

export const POS_PRINTER_PURPOSES = new Set(["generic", "production", "fiscal"]);

export const POS_PRINTER_MODELS = [
  {
    id: "generic_tcp",
    label: "Stampante di rete generica",
    kind: "network",
    modelCode: "",
  },
  {
    id: DEFAULT_FISCAL_PRINTER_MODEL,
    label: "Epson TM-T800F",
    kind: "fiscal",
    modelCode: "M261A",
  },
];

export const DEFAULT_VIRTUAL_WAITING_ROOM_ID = "room_attesa_virtuale";
export const DEFAULT_VIRTUAL_WAITING_ROOM_NAME = "Attesa virtuale";
export const DEFAULT_VIRTUAL_WAITING_ROOM_TABLE_COUNT = 10;

export const DEFAULT_POS_TABLES = Array.from(
  { length: DEFAULT_VIRTUAL_WAITING_ROOM_TABLE_COUNT },
  (_, index) => {
    const number = index + 1;
    return {
      id: `${DEFAULT_VIRTUAL_WAITING_ROOM_ID}_t${String(number).padStart(2, "0")}`,
      number,
      type: DEFAULT_VIRTUAL_WAITING_ROOM_NAME,
      roomId: DEFAULT_VIRTUAL_WAITING_ROOM_ID,
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    };
  }
);

export const DEFAULT_PAYMENT_METHODS = [
  { id: "pay_cash", label: "Contanti", enabled: true, isSmart: false, isFiscal: true },
  { id: "pay_card", label: "Carta", enabled: true, isSmart: false, isFiscal: true },
  { id: "pay_smart", label: "Smart", enabled: true, isSmart: true, isFiscal: false },
  { id: "pay_chip", label: "MyConto", enabled: true, isSmart: true, isFiscal: false },
];

export const DEFAULT_PAYMENT_TERMINALS = [
  {
    id: "pos_main",
    label: "POS Cassa Principale",
    enabled: true,
    provider: "mock",
    protocol: "mock",
    terminalId: "MOCK_MAIN",
    merchantId: "",
    serialNumber: "",
    ipAddress: "",
    port: "",
    workstationId: "cassa_principale",
    notes: "Terminale mock migrato in configurazione POS.",
  },
  {
    id: "pos_terrace",
    label: "POS Terrazza",
    enabled: true,
    provider: "mock",
    protocol: "mock",
    terminalId: "MOCK_TERRACE",
    merchantId: "",
    serialNumber: "",
    ipAddress: "",
    port: "",
    workstationId: "terrazza",
    notes: "Terminale mock migrato in configurazione POS.",
  },
  {
    id: "pos_mobile",
    label: "POS Mobile",
    enabled: true,
    provider: "mock",
    protocol: "mock",
    terminalId: "MOCK_MOBILE",
    merchantId: "",
    serialNumber: "",
    ipAddress: "",
    port: "",
    workstationId: "mobile",
    notes: "Terminale mock migrato in configurazione POS.",
  },
];

export const DEFAULT_SMART_CASH_SETTINGS = {
  beachEntryItemId: "menu_spiaggia_ombrellone",
  pointsPerEuro: 1,
};

export const DEFAULT_RADIO_CHANNELS = [
  { id: "bar", name: "Bar", enabled: true, color: "#00d2ff", sortOrder: 10 },
  { id: "generale", name: "Generale", enabled: true, color: "#2ed573", sortOrder: 20 },
  { id: "cassa", name: "Cassa", enabled: true, color: "#8b5cf6", sortOrder: 30 },
];

export const DEFAULT_POS_SETTINGS = {
  demoMode: false,
  sideBars: {
    leftMode: "fixed",
    rightMode: "collapse",
  },
  locale: {
    id: "locale_default",
    name: "Locale",
    alias: "Locale",
    businessName: "",
    vatNumber: "",
    address: "",
    sdiCode: "",
    legalRepresentative: "",
    status: "active",
  },
  locales: [
    {
      id: "locale_default",
      name: "Locale",
      alias: "Locale",
      businessName: "",
      vatNumber: "",
      address: "",
      sdiCode: "",
      legalRepresentative: "",
      status: "active",
    },
  ],
  activities: [
    {
      id: "activity_default",
      name: "Operativa",
      type: "operational",
      status: "active",
      fiscalPolicy: "standard",
      fiscalDeviceIds: [],
      menuIds: [],
      priceListIds: [],
      printerIds: [],
      workstationIds: [],
      menuSchedules: [],
      priceListSchedules: [],
    },
  ],
  activityRoomBindings: [],
  paymentMethods: DEFAULT_PAYMENT_METHODS,
  paymentTerminals: DEFAULT_PAYMENT_TERMINALS,
  smartCash: DEFAULT_SMART_CASH_SETTINGS,
  tables: DEFAULT_POS_TABLES,
  menus: [],
  areaMenus: [],
  priceLists: [],
  priceListSchedules: [],
  menuSchedules: [],
  printers: [],
  fiscalDevices: [],
  mobileDevices: [],
  radioChannels: DEFAULT_RADIO_CHANNELS,
  radioPreferences: [],
  workstations: [],
  areas: [
    {
      id: DEFAULT_VIRTUAL_WAITING_ROOM_ID,
      name: DEFAULT_VIRTUAL_WAITING_ROOM_NAME,
      minimumTables: DEFAULT_VIRTUAL_WAITING_ROOM_TABLE_COUNT,
      notes: "Sala virtuale di appoggio prima della sala reale finale.",
      menuIds: [],
      priceListIds: [],
      waiterUserIds: [],
      printerIds: [],
      cashPoints: [],
      workstations: [],
    },
  ],
  orderWorkflow: {
    deliveryConfirmationEnabled: true,
    requireReadyForDelivery: true,
    requireDeliveredForPayment: true,
  },
  printPreferences: {
    branding: {
      logoDataUrl: "",
      logoEscposBase64: "",
      venueName: "",
      address: "",
      phone: "",
      companyName: "",
      vatNumber: "",
    },
    preconto: {
      lineWidth: 48,
      lineSpacing: 48,
      showLogo: true,
      showVenueName: true,
      showAddress: true,
      showPhone: true,
      showCompanyName: true,
      showVatNumber: true,
      showDocumentLabel: true,
    },
    order: {
      lineWidth: 32,
      fontScalePercent: 100,
      charWidthMode: "normal",
      charSpacing: 0,
      lineSpacing: 0,
      bold: false,
      italic: false,
      underline: false,
      extraTopLines: [],
      extraBottomLines: [],
      showStation: true,
      showOrderId: true,
      showTable: true,
      showWaiter: true,
      showTime: true,
      showVariants: true,
      showLineNotes: true,
      showOrderNotes: true,
      showCommunications: true,
      showTotal: true,
    },
  },
};

export function cloneDefaultPosSettings() {
  return structuredClone(DEFAULT_POS_SETTINGS);
}

export function cloneDefaultPosPrintPreferences() {
  return structuredClone(DEFAULT_POS_SETTINGS.printPreferences);
}

export function clonePrinterModels() {
  return POS_PRINTER_MODELS.map((entry) => ({ ...entry }));
}
