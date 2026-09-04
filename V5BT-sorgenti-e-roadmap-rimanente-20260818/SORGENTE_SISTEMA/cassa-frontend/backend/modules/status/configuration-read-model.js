/**
 * Reader delle tre route di configurazione esposte dal modulo status
 * (P2b, dominio `configuration`): workflow comande, metodi di pagamento e
 * terminali.
 *
 * Sono endpoint di stato e si comportano diversamente dalle altre route del
 * dominio: leggono con `allowMigrations: false`, **non validano la sessione** e
 * prendono impostazioni e menu da `menuSettingsRepository` quando disponibile,
 * con fallback sull'app-state. Tutte e tre le differenze sono conservate qui.
 */
export function createConfigurationStatusReadModel({
  menuSettingsRepository,
  readDb,
  resolveSettingsVersion,
  sanitizePosSettings,
}) {
  async function leggiImpostazioni() {
    const db = await readDb({ allowMigrations: false });
    const sourceSettings = menuSettingsRepository?.getStaticPosSettings?.(db) ?? db?.posSettings;
    const sourceMenuItems = menuSettingsRepository?.getMenuItems?.(db) ?? db?.menuItems;
    const settings = sanitizePosSettings(sourceSettings, {
      menuItems: sourceMenuItems,
      users: db?.users,
    });
    return { settings, version: resolveSettingsVersion(db?.meta) };
  }

  async function readOrderWorkflowSettingsView() {
    const db = await readDb({ allowMigrations: false });
    const settings = sanitizePosSettings(db?.posSettings, {
      menuItems: db?.menuItems,
      users: db?.users,
    });
    const version = resolveSettingsVersion(db?.meta);
    return {
      ok: true,
      orderWorkflow: settings.orderWorkflow,
      settingsVersion: version,
      version,
    };
  }

  async function readPaymentMethodsSettingsView() {
    const { settings, version } = await leggiImpostazioni();
    const paymentMethods = Array.isArray(settings.paymentMethods)
      ? settings.paymentMethods.map((method) => ({
          id: String(method?.id ?? "").trim(),
          label: String(method?.label ?? "").trim(),
          enabled: method?.enabled !== false,
          isSmart: method?.isSmart === true,
          isFiscal: method?.isFiscal !== false,
        }))
      : [];
    return { ok: true, paymentMethods, settingsVersion: version, version };
  }

  async function readPaymentTerminalsSettingsView() {
    const { settings, version } = await leggiImpostazioni();
    const paymentTerminals = Array.isArray(settings.paymentTerminals)
      ? settings.paymentTerminals.map((terminal) => ({
          id: String(terminal?.id ?? "").trim(),
          label: String(terminal?.label ?? "").trim(),
          enabled: terminal?.enabled !== false,
          provider: String(terminal?.provider ?? "").trim(),
          protocol: String(terminal?.protocol ?? "").trim(),
          terminalId: String(terminal?.terminalId ?? "").trim(),
          merchantId: String(terminal?.merchantId ?? "").trim(),
          serialNumber: String(terminal?.serialNumber ?? "").trim(),
          ipAddress: String(terminal?.ipAddress ?? "").trim(),
          port: String(terminal?.port ?? "").trim(),
          workstationId: String(terminal?.workstationId ?? "").trim(),
          notes: String(terminal?.notes ?? "").trim(),
        }))
      : [];
    return { ok: true, paymentTerminals, settingsVersion: version, version };
  }

  return {
    readOrderWorkflowSettingsView,
    readPaymentMethodsSettingsView,
    readPaymentTerminalsSettingsView,
  };
}
