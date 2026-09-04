import type { Room } from "../../api/locations";
import type { MenuCatalogSnapshot } from "../../api/menu";
import type { ReservationSummary } from "../../api/reservations";
import type {
  IntegrationLayoutRoom,
  IntegrationLayoutOfflineLifecycle,
  IntegrationLayoutTable,
} from "../tables/integrationTypes";
import type { DiningTableOrder } from "../tables/types";

export const OFFLINE_CONFIGURATION_SCHEMA_VERSION = 2 as const;

export type OfflineConfigurationScope = {
  userId: string;
  activityId: string;
};

export type OfflineConfigurationSlice<T> = {
  serverVersion: number | string;
  updatedAt: number;
  value: T;
};

export type RemovedActiveTableLifecycle = IntegrationLayoutOfflineLifecycle;

export type OfflineLayoutTable = IntegrationLayoutTable & {
  offlineLifecycle?: RemovedActiveTableLifecycle;
  orderHistory?: DiningTableOrder[];
};

export type OfflineLayoutRoom = IntegrationLayoutRoom & {
  offlineLifecycle?: RemovedActiveTableLifecycle;
};

export type OfflineLayoutSnapshot = {
  version: number;
  rooms: OfflineLayoutRoom[];
  tables: OfflineLayoutTable[];
};

export type OfflineConfigurationPayload = {
  userId: string;
  activityId: string;
  lastRefreshAttemptAt: number;
  lastSuccessfulSyncAt: number;
  rooms: OfflineConfigurationSlice<Room[]> | null;
  layout: OfflineConfigurationSlice<OfflineLayoutSnapshot> | null;
  menusByRoom: Record<string, OfflineConfigurationSlice<MenuCatalogSnapshot>>;
  reservationsByRoomDate: Record<string, OfflineConfigurationSlice<ReservationSummary>>;
};

export type OfflineConfigurationSnapshot = OfflineConfigurationPayload & {
  key: string;
  schemaVersion: typeof OFFLINE_CONFIGURATION_SCHEMA_VERSION;
  revision: number;
  savedAt: number;
};

export type OfflineConfigurationRefreshResult = {
  snapshot: OfflineConfigurationSnapshot | null;
  refreshed: {
    rooms: boolean;
    layout: boolean;
    menuRoomIds: string[];
    reservationKeys: string[];
  };
};
