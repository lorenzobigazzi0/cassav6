export const POS_PERMISSION_DEFINITIONS = [
  {
    id: "collect_payments",
    label: "Incasso pagamenti",
    description: "Abilita i pagamenti e la chiusura dei conti in cassa.",
  },
  {
    id: "approve_room_change",
    label: "Approvazione cambio sala",
    description:
      "Consente di approvare o annullare richieste di spostamento tavolo.",
  },
  {
    id: "manage_tables",
    label: "Gestione tavoli",
    description:
      "Consente unione, divisione e spostamento dei tavoli operativi.",
  },
  {
    id: "manage_menu",
    label: "Gestione menu",
    description: "Permette modifiche al catalogo prodotti e categorie.",
  },
  {
    id: "override_order_price",
    label: "Override prezzi",
    description: "Permette modifiche manuali ai prezzi delle righe comanda.",
  },
  {
    id: "view_analytics",
    label: "Report e analytics",
    description: "Abilita la consultazione dei report vendite e statistiche.",
  },
  {
    id: "manage_sale_sessions",
    label: "Gestione sessioni vendita",
    description: "Consente apertura e chiusura delle sessioni di vendita.",
  },
  {
    id: "automatic_cash_admin",
    label: "Fondo cassa automatico",
    description:
      "Permette generazione, caricamento QR e configurazione del fondo cassa automatico.",
  },
  {
    id: "counter_mode",
    label: "Modalita Banco",
    description: "Permette l'accesso alla vendita rapida al banco da mobile.",
  },
  {
    id: "print_orders",
    label: "Stampa comande",
    description: "Consente invio ristampe e job di preparazione/stampa.",
  },
  {
    id: "open_drawer",
    label: "Apertura cassetto",
    description: "Consente l'apertura del cassetto fiscale/contanti.",
  },
  {
    id: "fiscal_operations",
    label: "Operazioni fiscali",
    description: "Consente comandi fiscali, chiusure e documenti fiscali.",
  },
  {
    id: "manage_settings",
    label: "Impostazioni POS",
    description:
      "Permette modifiche a impostazioni operative, sale, stampanti e metodi di pagamento.",
  },
  {
    id: "manage_reservations",
    label: "Gestione prenotazioni",
    description: "Permette creazione e modifica delle prenotazioni.",
  },
  {
    id: "manage_smart_customers",
    label: "Gestione MyConto",
    description:
      "Permette modifica clienti smart, ricariche e movimenti non fiscali.",
  },
  {
    id: "create_bar_replacement",
    label: "Sostituzioni a carico bar",
    description:
      "Permette di inviare sostituzioni operative non addebitate al cliente.",
  },
  {
    id: "manage_users",
    label: "Gestione utenti",
    description: "Permette di creare utenti e modificare ruoli/permessi.",
  },
];

export const KNOWN_PERMISSION_IDS = new Set(
  POS_PERMISSION_DEFINITIONS.map((entry) => entry.id),
);
export const ALL_POS_PERMISSION_IDS = POS_PERMISSION_DEFINITIONS.map(
  (entry) => entry.id,
);

export const ROLE_LABEL_BY_KEY = {
  operator: "Operatore",
  responsabile: "Responsabile",
  admin: "Amministratore",
};

export const MANAGEABLE_USER_ROLES = new Set(Object.keys(ROLE_LABEL_BY_KEY));

export function normalizeUserRole(role) {
  const normalized = String(role ?? "")
    .trim()
    .toLowerCase();
  if (MANAGEABLE_USER_ROLES.has(normalized)) {
    return normalized;
  }
  return "operator";
}

export function roleLabelFromRole(role) {
  const normalized = normalizeUserRole(role);
  return ROLE_LABEL_BY_KEY[normalized] ?? ROLE_LABEL_BY_KEY.operator;
}

export function resolvePermissions(role) {
  const normalizedRole = normalizeUserRole(role);
  if (normalizedRole === "admin") {
    return [...ALL_POS_PERMISSION_IDS];
  }
  if (normalizedRole === "responsabile") {
    return [
      "collect_payments",
      "approve_room_change",
      "manage_tables",
      "override_order_price",
      "view_analytics",
      "manage_sale_sessions",
      "print_orders",
      "open_drawer",
      "manage_reservations",
      "create_bar_replacement",
    ];
  }
  return ["create_bar_replacement"];
}

export function sanitizePermissionList(rawPermissions, options = {}) {
  const normalized = new Set();
  const role = normalizeUserRole(options.role);
  if (options.includeRoleDefaults) {
    resolvePermissions(role).forEach((permission) =>
      normalized.add(permission),
    );
  }
  if (Array.isArray(rawPermissions)) {
    for (const permission of rawPermissions) {
      const candidate = String(permission ?? "").trim();
      if (!candidate) continue;
      if (!KNOWN_PERMISSION_IDS.has(candidate)) continue;
      normalized.add(candidate);
    }
  }
  if (role === "admin") {
    ALL_POS_PERMISSION_IDS.forEach((permission) => normalized.add(permission));
  }
  return [...normalized];
}

export function hasPermission(user, permission) {
  if (!KNOWN_PERMISSION_IDS.has(permission)) return false;
  if (normalizeUserRole(user?.role) === "admin") return true;
  if (
    permission === "manage_tables" &&
    Array.isArray(user?.permissions) &&
    user.permissions.includes("manage_settings")
  ) {
    return true;
  }
  return (
    Array.isArray(user?.permissions) && user.permissions.includes(permission)
  );
}

export function isAdminUser(user) {
  return normalizeUserRole(user?.role) === "admin";
}
