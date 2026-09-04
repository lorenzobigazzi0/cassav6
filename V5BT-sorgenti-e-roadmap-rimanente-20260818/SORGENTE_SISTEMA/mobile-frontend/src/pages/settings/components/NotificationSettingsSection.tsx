import { SettingSwitch } from "./SettingSwitch";

interface NotificationSettingsSectionProps {
  autoShowWaiter: boolean;
  autoShowBell: boolean;
  onToggleAutoShowWaiter: () => void;
  onToggleAutoShowBell: () => void;
}

export function NotificationSettingsSection({
  autoShowWaiter,
  autoShowBell,
  onToggleAutoShowWaiter,
  onToggleAutoShowBell,
}: NotificationSettingsSectionProps) {
  return (
    <section className="settings-section">
      <div className="settings-section-subtitle">
        Se attivo: la prima notifica in arrivo viene mostrata subito a schermo. Se ne arrivano
        altre, restano in coda e si aprono solo da Home.
      </div>

      <div className="setting-row">
        <div className="setting-copy">
          <div className="setting-label">Chiamata cameriere</div>
          <div className="setting-help">Popup diretto solo con 1 nuova chiamata.</div>
        </div>
        <SettingSwitch
          enabled={autoShowWaiter}
          onToggle={onToggleAutoShowWaiter}
          label="Mostra subito chiamata cameriere"
        />
      </div>

      <div className="setting-row">
        <div className="setting-copy">
          <div className="setting-label">Comanda pronta</div>
          <div className="setting-help">Popup diretto solo con 1 nuova comanda.</div>
        </div>
        <SettingSwitch
          enabled={autoShowBell}
          onToggle={onToggleAutoShowBell}
          label="Mostra subito comanda pronta"
        />
      </div>
    </section>
  );
}
