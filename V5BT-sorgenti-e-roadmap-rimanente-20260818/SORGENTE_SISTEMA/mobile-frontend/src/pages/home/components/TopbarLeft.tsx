import bellIconSrc from "../../../assets/icons/service-bell.png";
import waiterIconSrc from "../../../assets/icons/waiter.png";
import { AppIcon } from "../../../components/AppIcon";
import type { CallNotification } from "../types";
import { CallHistoryMenu } from "./CallHistoryMenu";
import { LedButton } from "./LedButton";

interface TopbarLeftProps {
  waiterCount: number;
  bellCount: number;
  historyType: "waiter" | "bell" | null;
  waiterHistory: CallNotification[];
  bellHistory: CallNotification[];
  onOpenWaiter: () => void;
  onOpenBell: () => void;
  onDeleteHistoryById: (id: string) => void;
  onClearWaiterHistory: () => void;
  onClearBellHistory: () => void;
}

export function TopbarLeft({
  waiterCount,
  bellCount,
  historyType,
  waiterHistory,
  bellHistory,
  onOpenWaiter,
  onOpenBell,
  onDeleteHistoryById,
  onClearWaiterHistory,
  onClearBellHistory,
}: TopbarLeftProps) {
  return (
    <div className="topbar-left">
      <div className="led-history-wrap history-anchor-left">
        <LedButton
          className="led-waiter"
          count={waiterCount}
          ariaLabel="Cameriere"
          onClick={onOpenWaiter}
        >
          <AppIcon
            src={waiterIconSrc}
            className="icon"
            fallback={
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="8" cy="7" r="3" />
                <path d="M4 20c0-3 2-5 4-5s4 2 4 5" />
                <path d="M12 12h8" />
                <circle cx="20" cy="12" r="1" />
              </svg>
            }
          />
        </LedButton>

        {historyType === "waiter" && (
          <CallHistoryMenu
            title="Storico Cameriere"
            emptyText="Nessuna chiamata cameriere nello storico."
            history={waiterHistory}
            onDelete={onDeleteHistoryById}
            onClear={onClearWaiterHistory}
          />
        )}
      </div>

      <div className="led-history-wrap history-anchor-right">
        <LedButton
          className="led-bell"
          count={bellCount}
          ariaLabel="Campanello comande"
          onClick={onOpenBell}
        >
          <AppIcon
            src={bellIconSrc}
            className="icon"
            fallback={
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5h6a1 1 0 0 1 1 1v1H8V6a1 1 0 0 1 1-1z" />
                <path d="M5 14a7 7 0 0 1 14 0" />
                <path d="M4 16h16" />
                <path d="M6 19h12" />
              </svg>
            }
          />
        </LedButton>

        {historyType === "bell" && (
          <CallHistoryMenu
            title="Storico Comande Pronte"
            emptyText="Nessuna comanda pronta nello storico."
            history={bellHistory}
            onDelete={onDeleteHistoryById}
            onClear={onClearBellHistory}
          />
        )}
      </div>
    </div>
  );
}
