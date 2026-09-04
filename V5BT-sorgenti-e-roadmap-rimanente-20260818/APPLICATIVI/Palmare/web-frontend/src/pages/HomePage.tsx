import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import analyticsIconSrc from "../assets/icons/stats.png";
import bancoIconSrc from "../assets/icons/banco.png";
import bookingsIconSrc from "../assets/icons/bookings.png";
import homeIconSrc from "../assets/icons/home.png";
import menuIconSrc from "../assets/icons/menu.png";
import tablesIconSrc from "../assets/icons/table.svg";
import { AppIcon } from "../components/AppIcon";
import { endCurrentSession } from "../app/session/endSession";
import { readSessionPreference, writeSessionPreference } from "../shared/storage/preferenceStorage";
import { useAuthStore } from "../store/authStore";
import { usePaymentSettingsStore } from "../store/paymentSettingsStore";
import { CallAlertOverlay } from "./home/components/CallAlertOverlay";
import { BottomBar, type BottomTabItem, type BottomTabKey } from "./home/components/BottomBar";
import { HomeWorkspace } from "./home/components/HomeWorkspace";
import { LogoutConfirmDialog } from "./home/components/LogoutConfirmDialog";
import { SystemRow } from "./home/components/SystemRow";
import { TopBar } from "./home/components/TopBar";
import { useNotificationCenterContext } from "./home/context/NotificationCenterContext";
import { useThemeMode } from "./home/hooks/useThemeMode";
import { useMenuSessionSync } from "./home/menu/hooks/useMenuSessionSync";
import { buildMockNotification } from "./home/utils/mockMessages";
import type { AnalyticsViewMode } from "./home/analytics/AnalyticsWorkspace";
import { canUseCounterMode } from "./home/tables/counter/counterModePermission";

const HOME_TABS: BottomTabItem[] = [
  {
    key: "home",
    label: "HOME",
    icon: (
      <AppIcon
        src={homeIconSrc}
        className="icon"
        fallback={
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 11.5L12 4l9 7.5" />
            <path d="M6 10v9h12v-9" />
          </svg>
        }
      />
    ),
  },
  {
    key: "menu",
    label: "MENU",
    icon: (
      <AppIcon
        src={menuIconSrc}
        className="icon"
        fallback={
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h7" />
            <path d="M5 10h5" />
            <path d="M6.4 3.5v3.2" />
            <path d="M8.6 3.5v3.2" />
            <path d="M7.5 10v7.5" />
            <path d="M13 9.5h7" />
            <path d="M13.5 12.5h6" />
            <path d="M13 15.5h7" />
            <path d="M14 18h5" />
          </svg>
        }
      />
    ),
  },
  {
    key: "tavoli",
    label: "TAVOLI",
    icon: (
      <AppIcon
        src={tablesIconSrc}
        className="icon"
        fallback={
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="7" width="12" height="8" rx="2" />
            <path d="M9 15v3" />
            <path d="M15 15v3" />
          </svg>
        }
      />
    ),
  },
  {
    key: "prenotazioni",
    label: "PRENOTAZIONI",
    icon: (
      <AppIcon
        src={bookingsIconSrc}
        className="icon"
        fallback={
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M8 3v4" />
            <path d="M16 3v4" />
            <path d="M4 10h16" />
          </svg>
        }
      />
    ),
  },
  {
    key: "analytics",
    label: "STATISTICHE",
    icon: (
      <AppIcon
        src={analyticsIconSrc}
        className="icon"
        fallback={
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 19V9" />
            <path d="M12 19V5" />
            <path d="M19 19v-7" />
          </svg>
        }
      />
    ),
  },
];

const PAGE_TITLES: Record<BottomTabKey, string> = {
  home: "HOME",
  menu: "MENU",
  tavoli: "TAVOLI",
  prenotazioni: "PRENOTAZIONI",
  analytics: "STATISTICHE",
};

const HOME_ACTIVE_TAB_KEY = "home_active_tab";
const HOME_TABLES_MODE_KEY = "home_tables_workspace_mode";
const DASHBOARD_QUICK_FILTER_EVENT = "mobile:dashboard:quick-filter";
const TABLES_COUNTER_FADE_MS = 180;
type DashboardTableFilter = "free" | "occupied" | "ordering" | "payment_due";
type TablesWorkspaceMode = "tables" | "counter";

const isBottomTabKey = (value: string): value is BottomTabKey =>
  HOME_TABS.some((tab) => tab.key === value);

const getStoredHomeTab = (): BottomTabKey => {
  try {
    const saved = readSessionPreference(HOME_ACTIVE_TAB_KEY) ?? "";
    if (isBottomTabKey(saved)) return saved;
  } catch {
    // ignore storage failures
  }
  return "home";
};

const getStoredTablesWorkspaceMode = (): TablesWorkspaceMode => {
  try {
    return readSessionPreference(HOME_TABLES_MODE_KEY) === "counter" ? "counter" : "tables";
  } catch {
    return "tables";
  }
};

export function HomePage() {
  const navigate = useNavigate();
  const { username, fullName, permissions, role } = useAuthStore();
  const { posId, cashFloat, cashFloatLocked } = usePaymentSettingsStore();
  const [activeTab, setActiveTab] = useState<BottomTabKey>(() => getStoredHomeTab());
  const [tablesWorkspaceMode, setTablesWorkspaceMode] = useState<TablesWorkspaceMode>(
    getStoredTablesWorkspaceMode
  );
  const [analyticsViewMode, setAnalyticsViewMode] = useState<AnalyticsViewMode>("payments");
  const [analyticsModePickerOpen, setAnalyticsModePickerOpen] = useState(false);
  useMenuSessionSync(activeTab === "menu");
  const { isDark, setTheme } = useThemeMode();
  const {
    waiterCount,
    bellCount,
    activeCall,
    callHistory,
    notifications,
    unreadCount,
    readCount,
    dispatchMockNotification,
    openOldestCall,
    closeActiveCall,
    confirmActiveCall,
    deleteCallHistoryById,
    confirmNotification,
    deleteNotificationById,
    clearReadNotifications,
    clearAllNotifications,
  } = useNotificationCenterContext();

  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [historyType, setHistoryType] = useState<"waiter" | "bell" | null>(null);
  const [slideDirection, setSlideDirection] = useState<"forward" | "backward" | "none">("none");
  const [tablesQuickFilter, setTablesQuickFilter] = useState<{
    filter: DashboardTableFilter;
    nonce: number;
  } | null>(null);
  const [tablesCounterTransitioning, setTablesCounterTransitioning] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const tablesCounterTransitionTimerRef = useRef<number | null>(null);
  const tablesCounterTransitionFrameRef = useRef<number | null>(null);

  const operatorDisplayName = (fullName || username || "").trim();
  const paymentMethodsConfigured = Boolean(posId) || (cashFloatLocked && cashFloat !== null);
  const canCollectPayments = permissions.includes("collect_payments");
  const canPickAnalyticsMode = role === "admin";
  const canPickCounterMode = canUseCounterMode({ role, permissions });
  const showPaymentAlert = canCollectPayments && !paymentMethodsConfigured;
  const counterModeActive = activeTab === "tavoli" && tablesWorkspaceMode === "counter";
  const effectivePageTitle = counterModeActive ? "BANCO" : PAGE_TITLES[activeTab];

  const homeTabs = useMemo<BottomTabItem[]>(
    () =>
      HOME_TABS.map((tab) =>
        tab.key === "tavoli" && tablesWorkspaceMode === "counter"
          ? {
              ...tab,
              label: "BANCO",
              icon: (
                <AppIcon
                  src={bancoIconSrc}
                  className="icon bottom-btn-banco-icon"
                  fallback={
                    <svg
                      className="icon bottom-btn-banco-icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M4 16h16" />
                      <path d="M6 16v-4a6 6 0 0 1 12 0v4" />
                      <path d="M8 20h8" />
                    </svg>
                  }
                />
              ),
            }
          : tab
      ),
    [tablesWorkspaceMode]
  );

  const initials = useMemo(() => {
    const raw = operatorDisplayName;
    if (!raw) return "OP";
    const parts = raw.split(/[\s._-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }, [operatorDisplayName]);

  useEffect(() => {
    if (!menuOpen && !notifOpen && !historyType) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const t = target as Node;
      if (menuRef.current && menuRef.current.contains(t)) return;
      if (notifRef.current && notifRef.current.contains(t)) return;
      if (target.closest(".led-history-wrap")) return;
      setMenuOpen(false);
      setNotifOpen(false);
      setHistoryType(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, notifOpen, historyType]);

  useEffect(
    () => () => {
      if (tablesCounterTransitionTimerRef.current !== null) {
        window.clearTimeout(tablesCounterTransitionTimerRef.current);
      }
      if (tablesCounterTransitionFrameRef.current !== null) {
        window.cancelAnimationFrame(tablesCounterTransitionFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (activeCall) {
      setHistoryType(null);
    }
  }, [activeCall]);

  useEffect(() => {
    try {
      writeSessionPreference(HOME_ACTIVE_TAB_KEY, activeTab);
    } catch {
      // ignore storage failures
    }
  }, [activeTab]);

  useEffect(() => {
    if (canPickAnalyticsMode) return;
    setAnalyticsModePickerOpen(false);
    setAnalyticsViewMode("payments");
  }, [canPickAnalyticsMode]);

  useEffect(() => {
    if (canPickCounterMode) return;
    setTablesWorkspaceMode("tables");
  }, [canPickCounterMode]);

  useEffect(() => {
    try {
      writeSessionPreference(HOME_TABLES_MODE_KEY, tablesWorkspaceMode);
    } catch {
      // ignore storage failures
    }
  }, [tablesWorkspaceMode]);

  const waiterHistory = useMemo(
    () => callHistory.filter((item) => item.type === "waiter"),
    [callHistory]
  );

  const bellHistory = useMemo(
    () => callHistory.filter((item) => item.type === "bell"),
    [callHistory]
  );

  const clearTypeHistory = (type: "waiter" | "bell") => {
    callHistory
      .filter((item) => item.type === type)
      .forEach((item) => deleteCallHistoryById(item.id));
  };

  const onTabChange = (
    nextTab: BottomTabKey,
    options: { keepDashboardQuickFilter?: boolean } = {}
  ) => {
    const currentIndex = HOME_TABS.findIndex((tab) => tab.key === activeTab);
    const nextIndex = HOME_TABS.findIndex((tab) => tab.key === nextTab);
    if (nextTab !== "tavoli" || options.keepDashboardQuickFilter !== true) {
      setTablesQuickFilter(null);
    }
    setSlideDirection(nextIndex >= currentIndex ? "forward" : "backward");
    setActiveTab(nextTab);
    setMenuOpen(false);
    setNotifOpen(false);
    setHistoryType(null);
  };

  const openTablesWithDashboardFilter = (filter: DashboardTableFilter) => {
    setTablesWorkspaceMode("tables");
    setTablesQuickFilter((current) => ({ filter, nonce: (current?.nonce ?? 0) + 1 }));
    onTabChange("tavoli", { keepDashboardQuickFilter: true });
    window.dispatchEvent(new CustomEvent(DASHBOARD_QUICK_FILTER_EVENT, { detail: { filter } }));
  };

  const openAnalyticsModePicker = () => {
    if (activeTab !== "analytics" || !canPickAnalyticsMode) return;
    setMenuOpen(false);
    setNotifOpen(false);
    setHistoryType(null);
    setAnalyticsModePickerOpen(true);
  };

  const toggleTablesWorkspaceMode = () => {
    if (activeTab !== "tavoli" || !canPickCounterMode) return;
    if (tablesCounterTransitioning || tablesCounterTransitionTimerRef.current !== null) return;
    setTablesQuickFilter(null);
    setTablesCounterTransitioning(true);
    tablesCounterTransitionTimerRef.current = window.setTimeout(() => {
      tablesCounterTransitionTimerRef.current = null;
      setTablesWorkspaceMode((current) => (current === "counter" ? "tables" : "counter"));
      tablesCounterTransitionFrameRef.current = window.requestAnimationFrame(() => {
        tablesCounterTransitionFrameRef.current = null;
        setTablesCounterTransitioning(false);
      });
    }, TABLES_COUNTER_FADE_MS);
  };

  const selectAnalyticsMode = (mode: AnalyticsViewMode) => {
    setAnalyticsViewMode(mode);
    setAnalyticsModePickerOpen(false);
  };

  const isTablesTab = activeTab === "tavoli";
  const homePageClassName = `page home-page ${isTablesTab ? "home-page-tavoli" : ""}`;
  const homeShellClassName = `home-shell ${isTablesTab ? "home-shell-tavoli" : ""} ${
    tablesCounterTransitioning ? "is-tables-counter-transitioning" : ""
  }`;

  return (
    <div className={homePageClassName}>
      <div className={homeShellClassName}>
        <SystemRow />

        <TopBar
          pageTitle={effectivePageTitle}
          waiterCount={waiterCount}
          bellCount={bellCount}
          historyType={historyType}
          waiterHistory={waiterHistory}
          bellHistory={bellHistory}
          onOpenWaiter={() => {
            setMenuOpen(false);
            setNotifOpen(false);
            if (waiterCount > 0) {
              setHistoryType(null);
              openOldestCall("waiter");
              return;
            }
            setHistoryType((prev) => (prev === "waiter" ? null : "waiter"));
          }}
          onOpenBell={() => {
            setMenuOpen(false);
            setNotifOpen(false);
            if (bellCount > 0) {
              setHistoryType(null);
              openOldestCall("bell");
              return;
            }
            setHistoryType((prev) => (prev === "bell" ? null : "bell"));
          }}
          onDeleteHistoryById={deleteCallHistoryById}
          onClearWaiterHistory={() => clearTypeHistory("waiter")}
          onClearBellHistory={() => clearTypeHistory("bell")}
          menuOpen={menuOpen}
          notifOpen={notifOpen}
          unreadCount={unreadCount}
          readCount={readCount}
          notifications={notifications}
          canCollectPayments={canCollectPayments}
          initials={initials}
          username={operatorDisplayName}
          isDark={isDark}
          menuRef={menuRef}
          notifRef={notifRef}
          onToggleMenu={() => {
            setHistoryType(null);
            setNotifOpen(false);
            setMenuOpen((v) => !v);
          }}
          onToggleNotif={() => {
            setHistoryType(null);
            setMenuOpen(false);
            setNotifOpen((v) => !v);
          }}
          onThemeToggle={() => setTheme(isDark ? "light" : "dark")}
          onOpenProfile={() => {
            setMenuOpen(false);
            setHistoryType(null);
            navigate("/profile");
          }}
          onOpenSettings={() => {
            setMenuOpen(false);
            setHistoryType(null);
            navigate("/settings");
          }}
          onOpenRadio={() => {
            setMenuOpen(false);
            setHistoryType(null);
            navigate("/radio");
          }}
          onOpenPayments={() => {
            if (!canCollectPayments) return;
            setMenuOpen(false);
            setHistoryType(null);
            navigate("/payments");
          }}
          onTitleLongPress={
            activeTab === "tavoli" && canPickCounterMode
              ? toggleTablesWorkspaceMode
              : activeTab === "analytics" && canPickAnalyticsMode
                ? openAnalyticsModePicker
                : undefined
          }
          showPaymentAlert={showPaymentAlert}
          onLogout={() => {
            setMenuOpen(false);
            setHistoryType(null);
            setLogoutConfirmOpen(true);
          }}
          onClearRead={clearReadNotifications}
          onClearAll={clearAllNotifications}
          onConfirm={confirmNotification}
          onDelete={deleteNotificationById}
        />

        <div className={`home-content home-content-${activeTab}`}>
          <div
            key={activeTab}
            className={`home-view home-view-${slideDirection} view-${activeTab}`}
          >
            <HomeWorkspace
              tab={activeTab}
              username={operatorDisplayName}
              tablesQuickFilter={tablesQuickFilter}
              tablesWorkspaceMode={tablesWorkspaceMode}
              tablesRoomPickerRequest={null}
              analyticsViewMode={analyticsViewMode}
              onSimulateWaiter={() => {
                const payload = buildMockNotification("waiter");
                dispatchMockNotification("waiter", payload);
              }}
              onSimulateBell={() => {
                const payload = buildMockNotification("bell");
                dispatchMockNotification("bell", payload);
              }}
              onSimulateGeneral={() => {
                const payload = buildMockNotification("general");
                dispatchMockNotification("general", payload);
              }}
              onOpenTablesFilter={openTablesWithDashboardFilter}
            />
          </div>
        </div>

        <BottomBar tabs={homeTabs} activeTab={activeTab} onChange={onTabChange} />
      </div>
      {analyticsModePickerOpen ? (
        <div
          className="mobile-analytics-detail-backdrop analytics-mode-picker-backdrop"
          onPointerDown={() => setAnalyticsModePickerOpen(false)}
        >
          <section
            className="mobile-analytics-detail-modal analytics-mode-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Vista statistiche"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="mobile-analytics-detail-head">
              <div>
                <span>Statistiche</span>
                <strong>Seleziona vista</strong>
              </div>
              <div className="mobile-analytics-detail-actions">
                <button
                  type="button"
                  className="smallbtn mobile-analytics-detail-close"
                  aria-label="Chiudi"
                  onClick={() => setAnalyticsModePickerOpen(false)}
                >
                  X
                </button>
              </div>
            </header>
            <div className="analytics-mode-picker-actions">
              <button
                type="button"
                className={`smallbtn analytics-mode-picker-btn is-payments ${
                  analyticsViewMode === "payments" ? "is-active" : ""
                }`}
                onClick={() => selectAnalyticsMode("payments")}
              >
                PAGAMENTI
              </button>
              <button
                type="button"
                className={`smallbtn analytics-mode-picker-btn is-cash-movements ${
                  analyticsViewMode === "cash_movements" ? "is-active" : ""
                }`}
                onClick={() => selectAnalyticsMode("cash_movements")}
              >
                MOVIMENTI
              </button>
              <button
                type="button"
                className={`smallbtn analytics-mode-picker-btn is-cash-floats ${
                  analyticsViewMode === "cash_floats" ? "is-active" : ""
                }`}
                onClick={() => selectAnalyticsMode("cash_floats")}
              >
                FONDI CASSA
              </button>
            </div>
          </section>
        </div>
      ) : null}
      <LogoutConfirmDialog
        open={logoutConfirmOpen}
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          endCurrentSession();
        }}
      />
      <CallAlertOverlay
        notification={activeCall}
        onClose={closeActiveCall}
        onConfirm={confirmActiveCall}
      />
    </div>
  );
}
