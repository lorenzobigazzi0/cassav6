import type { CSSProperties } from "react";
import { SystemRow } from "../home/components/SystemRow";

type SwipeBackHomePreviewProps = {
  timeLabel: string;
  revealProgress: number;
};

export function SwipeBackHomePreview({ timeLabel, revealProgress }: SwipeBackHomePreviewProps) {
  const clampedReveal = Math.min(1, Math.max(0, revealProgress));
  const style = {
    "--swipe-reveal": clampedReveal.toString(),
  } as CSSProperties;

  return (
    <div className="swipe-underlay" style={style} aria-hidden="true">
      <div className="home-shell swipe-underlay-shell">
        <SystemRow timeLabel={timeLabel} showBattery={false} />

        <div className="home-topbar swipe-underlay-topbar">
          <div className="swipe-underlay-group">
            <span className="swipe-underlay-pill" />
            <span className="swipe-underlay-pill" />
          </div>
          <div className="topbar-title">Home</div>
          <div className="swipe-underlay-group swipe-underlay-group-right">
            <span className="swipe-underlay-dot" />
            <span className="swipe-underlay-avatar" />
          </div>
        </div>

        <div className="home-content swipe-underlay-content">
          <div className="glass-card home-card swipe-underlay-card">
            <div className="card-body swipe-underlay-card-body">
              <div className="swipe-underlay-line is-large" />
              <div className="swipe-underlay-grid">
                <span className="swipe-underlay-chip" />
                <span className="swipe-underlay-chip" />
                <span className="swipe-underlay-chip" />
                <span className="swipe-underlay-chip" />
              </div>
              <div className="swipe-underlay-line" />
              <div className="swipe-underlay-line is-small" />
              <div className="swipe-underlay-line" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
