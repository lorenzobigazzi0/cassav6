import type { ReactNode } from "react";
import { formatCount } from "../utils/format";

interface LedButtonProps {
  className: string;
  count: number;
  ariaLabel: string;
  onClick: () => void;
  children: ReactNode;
}

export function LedButton({ className, count, ariaLabel, onClick, children }: LedButtonProps) {
  return (
    <button
      className={`led-btn ${className} ${count > 0 ? "is-alert" : ""}`}
      type="button"
      aria-label={count ? `${ariaLabel} (${count})` : ariaLabel}
      onClick={onClick}
    >
      {count > 0 && <span className="led-count">{formatCount(count)}</span>}
      {children}
    </button>
  );
}
