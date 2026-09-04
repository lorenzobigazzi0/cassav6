import { memo, type CSSProperties } from "react";
import { useMobileBatteryStatus } from "../../../app/runtime/BatteryStatusContext";

function MobileBatteryWidgetComponent() {
  const batteryState = useMobileBatteryStatus();

  if (batteryState.kind === "unknown") {
    return (
      <span
        className="mobile-battery-widget is-unknown"
        role="img"
        aria-label={batteryState.message}
        title={batteryState.message}
      >
        <span className="mobile-battery-shell" aria-hidden="true">
          <span
            className="mobile-battery-fill"
            style={{ "--mobile-battery-level": "0" } as CSSProperties}
          />
          <span className="mobile-battery-value" aria-hidden="true">
            --
          </span>
          <span className="mobile-battery-bolt">{"\u26a1"}</span>
        </span>
      </span>
    );
  }

  const level = Math.max(0, Math.min(100, Math.round(batteryState.device.level)));
  const deviceName = batteryState.device.deviceName ? ` ${batteryState.device.deviceName}` : "";
  const chargeText = batteryState.device.charging ? "in carica" : "non in carica";
  const staleText = batteryState.stale ? " (dato temporaneamente in cache)" : "";
  const label = `Batteria${deviceName}: ${level} percento, ${chargeText}${staleText}`;

  return (
    <span
      className={[
        "mobile-battery-widget",
        level < 20 ? "is-low" : "",
        batteryState.device.charging ? "is-charging" : "",
        batteryState.device.online === false ? "is-offline" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={label}
      title={label}
      data-level={level}
    >
      <span className="mobile-battery-shell" aria-hidden="true">
        <span
          className="mobile-battery-fill"
          style={{ "--mobile-battery-level": String(level / 100) } as CSSProperties}
        />
        <span className="mobile-battery-value" aria-hidden="true">
          {level}
        </span>
        <span className="mobile-battery-bolt">{"\u26a1"}</span>
      </span>
    </span>
  );
}

export const MobileBatteryWidget = memo(MobileBatteryWidgetComponent);
