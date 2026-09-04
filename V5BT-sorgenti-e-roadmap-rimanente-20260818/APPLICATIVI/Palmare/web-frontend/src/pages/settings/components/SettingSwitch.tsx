interface SettingSwitchProps {
  enabled: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
  disabled?: boolean;
}

export function SettingSwitch({
  enabled,
  onToggle,
  label,
  className = "",
  disabled = false,
}: SettingSwitchProps) {
  return (
    <button
      className={`setting-switch ${enabled ? "is-on" : ""} ${disabled ? "is-disabled" : ""} ${className}`.trim()}
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="setting-switch-track">
        <span className="setting-switch-thumb" />
      </span>
    </button>
  );
}
