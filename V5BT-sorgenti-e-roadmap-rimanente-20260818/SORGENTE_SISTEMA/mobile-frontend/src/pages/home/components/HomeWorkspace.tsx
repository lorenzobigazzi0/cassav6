import { lazy, Suspense, useEffect, useState } from "react";
import { GlassCard } from "../../../components/GlassCard";
import { HomeCard } from "./HomeCard";
import type { BottomTabKey } from "./BottomBar";
import type { AnalyticsViewMode } from "../analytics/AnalyticsWorkspace";

const MenuWorkspace = lazy(() =>
  import("../menu/MenuWorkspace").then((module) => ({ default: module.MenuWorkspace }))
);
const TablesWorkspace = lazy(() =>
  import("../tables/TablesWorkspace").then((module) => ({ default: module.TablesWorkspace }))
);
const ReservationsWorkspace = lazy(() =>
  import("../reservations/ReservationsWorkspace").then((module) => ({
    default: module.ReservationsWorkspace,
  }))
);
const AnalyticsWorkspace = lazy(() =>
  import("../analytics/AnalyticsWorkspace").then((module) => ({
    default: module.AnalyticsWorkspace,
  }))
);

interface HomeWorkspaceProps {
  tab: BottomTabKey;
  username: string;
  tablesQuickFilter: {
    filter: "free" | "occupied" | "ordering" | "payment_due";
    nonce: number;
  } | null;
  tablesWorkspaceMode: "tables" | "counter";
  tablesRoomPickerRequest: { nonce: number } | null;
  analyticsViewMode: AnalyticsViewMode;
  onSimulateWaiter: () => void;
  onSimulateBell: () => void;
  onSimulateGeneral: () => void;
  onOpenTablesFilter: (filter: "free" | "occupied" | "ordering" | "payment_due") => void;
}

function WorkspaceFallback({
  label,
  cardClassName = "",
  bodyClassName = "",
}: {
  label: string;
  cardClassName?: string;
  bodyClassName?: string;
}) {
  const cardClass = `home-card workspace-card ${cardClassName}`.trim();
  const bodyClass = `card-body ${bodyClassName}`.trim();

  return (
    <GlassCard className={cardClass}>
      <div className={bodyClass}>
        <div className="tables-empty-state">{label}</div>
      </div>
    </GlassCard>
  );
}

export function HomeWorkspace({
  tab,
  username,
  tablesQuickFilter,
  tablesWorkspaceMode,
  tablesRoomPickerRequest,
  analyticsViewMode,
  onSimulateWaiter,
  onSimulateBell,
  onSimulateGeneral,
  onOpenTablesFilter,
}: HomeWorkspaceProps) {
  const [tablesMounted, setTablesMounted] = useState(tab === "tavoli");

  useEffect(() => {
    if (tab === "tavoli") setTablesMounted(true);
  }, [tab]);

  return (
    <>
      {tab === "home" && (
        <HomeCard
          username={username}
          onSimulateWaiter={onSimulateWaiter}
          onSimulateBell={onSimulateBell}
          onSimulateGeneral={onSimulateGeneral}
          onOpenTablesFilter={onOpenTablesFilter}
        />
      )}

      {tab === "menu" && (
        <Suspense
          fallback={
            <WorkspaceFallback label="Caricamento menu..." cardClassName="menu-workspace-card" />
          }
        >
          <MenuWorkspace />
        </Suspense>
      )}

      {tab === "prenotazioni" && (
        <Suspense
          fallback={
            <WorkspaceFallback
              label="Caricamento prenotazioni..."
              cardClassName="reservations-card"
            />
          }
        >
          <ReservationsWorkspace />
        </Suspense>
      )}

      {tab === "analytics" && (
        <Suspense
          fallback={
            <WorkspaceFallback
              label="Caricamento statistiche..."
              cardClassName="analytics-workspace-card mobile-analytics-clean"
            />
          }
        >
          <AnalyticsWorkspace viewMode={analyticsViewMode} />
        </Suspense>
      )}

      {tablesMounted && (
        <div
          className="home-tab-pane home-tab-pane-tavoli"
          style={{ display: tab === "tavoli" ? "flex" : "none" }}
          aria-hidden={tab !== "tavoli"}
        >
          <Suspense
            fallback={
              <WorkspaceFallback
                label="Caricamento tavoli..."
                cardClassName="tables-workspace-card"
                bodyClassName="tables-card-body"
              />
            }
          >
            <TablesWorkspace
              active={tab === "tavoli"}
              counterMode={tablesWorkspaceMode === "counter"}
              dashboardQuickFilter={tablesQuickFilter}
              roomPickerRequest={tablesRoomPickerRequest}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
