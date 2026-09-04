const DEFAULT_BASE_URL = "https://127.0.0.1:5280";

function envString(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

const options = {
  baseUrl: envString("CASSAV4_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, ""),
  username: envString("CASSAV4_SEED_USERNAME", "amalia"),
  pin: envString("CASSAV4_SEED_PIN", "182018"),
  deviceUuid: envString("CASSAV4_SEED_DEVICE_UUID", `seed-commercial-workstations-${Date.now()}`),
  insecureTls: envBool("CASSAV4_INSECURE_TLS", true),
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const COMMERCIAL_WORKSTATIONS = [
  {
    id: "workstation_bar_principale",
    name: "BAR PRINCIPALE",
    stationName: "BAR PRINCIPALE",
    active: true,
    status: "active",
    roomIds: [],
    printerIds: [],
    precontoPrinterIds: [],
    categoryIds: [
      "Caffetteria",
      "Bevande",
      "Birre",
      "Vino e Prosecco",
      "Drink",
      "Drink Premium",
      "Signature Cocktail",
      "Gelati",
      "Gelato Premium",
      "cat_caffetteria",
      "cat_bevande",
      "cat_birre",
      "cat_vino_e_prosecco",
      "cat_drink",
      "cat_drink_premium",
      "cat_signature_cocktail",
      "cat_gelati",
      "cat_gelato_premium",
    ],
    printOrderEnabled: false,
    printPrecontoEnabled: false,
    printTableChangesEnabled: false,
  },
  {
    id: "workstation_cucina",
    name: "CUCINA",
    stationName: "CUCINA",
    active: true,
    status: "active",
    roomIds: [],
    printerIds: [],
    precontoPrinterIds: [],
    categoryIds: [
      "Cucina",
      "Pizza",
      "Pizzeria",
      "Primi",
      "Secondi",
      "Fritti",
      "Panini",
      "Food",
      "cat_cucina",
      "cat_pizza",
      "cat_pizzeria",
      "cat_primi",
      "cat_secondi",
      "cat_fritti",
      "cat_panini",
      "cat_food",
    ],
    printOrderEnabled: false,
    printPrecontoEnabled: false,
    printTableChangesEnabled: false,
  },
];

async function requestJson(pathname, init = {}) {
  const response = await fetch(`${options.baseUrl}${pathname}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body:
      init.body === undefined || typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { text };
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} ${response.status} ${body?.error ?? body?.code ?? text}`,
    );
  }
  return { response, body };
}

function authPayload(session, patch = {}) {
  return {
    token: session.token,
    userId: session.user?.id,
    username: session.user?.username,
    fullName: session.user?.fullName,
    deviceUuid: options.deviceUuid,
    clientApp: "mobile-frontend",
    ...patch,
  };
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user?.id ?? "",
    "X-Device-Uuid": options.deviceUuid,
  };
}

function mergeWorkstations(existing) {
  const byId = new Map(
    (Array.isArray(existing) ? existing : []).map((entry) => [
      String(entry?.id ?? entry?.stationName ?? entry?.name ?? "").trim(),
      entry,
    ]),
  );
  COMMERCIAL_WORKSTATIONS.forEach((entry) => {
    byId.set(entry.id, { ...(byId.get(entry.id) ?? {}), ...entry });
  });
  return [...byId.values()];
}

async function main() {
  const login = await requestJson("/api/auth/login", {
    method: "POST",
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid: options.deviceUuid,
      clientApp: "mobile-frontend",
    },
  });
  const session = login.body;
  if (!session?.token || !session?.user?.id) {
    throw new Error("Login seed workstations non valido.");
  }

  const current = await requestJson("/api/settings/pos/areas", {
    method: "POST",
    headers: authHeaders(session),
    body: authPayload(session),
  });
  const workstations = mergeWorkstations(current.body?.workstations);
  const savePayload = authPayload(session, {
    locale: current.body?.locale,
    locales: current.body?.locales,
    demoMode: current.body?.demoMode,
    mobileDevices: current.body?.mobileDevices,
    activities: current.body?.activities,
    activityRoomBindings: current.body?.activityRoomBindings,
    areas: current.body?.areas,
    menus: current.body?.menus,
    areaMenus: current.body?.areaMenus,
    priceLists: current.body?.priceLists,
    priceListSchedules: current.body?.priceListSchedules,
    menuSchedules: current.body?.menuSchedules,
    printers: current.body?.printers,
    fiscalDevices: current.body?.fiscalDevices,
    workstations,
  });

  const saved = await requestJson("/api/settings/pos/areas/save", {
    method: "POST",
    headers: authHeaders(session),
    body: savePayload,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: options.baseUrl,
        configuredStations: saved.body?.configuredStations ?? [],
        workstations: (saved.body?.workstations ?? []).map((entry) => ({
          id: entry.id,
          stationName: entry.stationName,
          status: entry.status,
          categoryIds: Array.isArray(entry.categoryIds) ? entry.categoryIds.length : 0,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[seed-commercial-workstations] errore", error);
  process.exitCode = 1;
});
