import type { CSSProperties } from "react";

// Replaces the previously DOM-injected #pos-settings-sync-banner element and its
// hand-written <style>. Styles mirror the original banner (fixed bottom-right,
// dark glass, fade/slide transition) as inline styles so no global CSS override
// debt is added.
const bannerStyle: CSSProperties = {
  position: "fixed",
  right: "16px",
  bottom: "16px",
  zIndex: 100000,
  minHeight: "42px",
  padding: "10px 14px",
  borderRadius: "14px",
  background: "rgba(10, 28, 49, 0.94)",
  color: "#f5fbff",
  border: "1px solid rgba(157, 212, 255, 0.34)",
  boxShadow: "0 16px 34px rgba(0, 0, 0, 0.28)",
  fontSize: "13px",
  fontWeight: 820,
  letterSpacing: "0.02em",
  transition: "opacity 140ms ease, transform 140ms ease",
  pointerEvents: "none",
};

export function SettingsSyncBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div
      id="pos-settings-sync-banner"
      aria-live="polite"
      style={{
        ...bannerStyle,
        opacity: 1,
        transform: "translateY(0)",
      }}
    >
      Configurazione aggiornata.
    </div>
  );
}
