export type LoginRequest = {
  username: string;
  pin: string;
  deviceUuid: string;
};

export type UserRole = "operator" | "responsabile" | "admin";

export type AuthPermission =
  | "collect_payments"
  | "approve_room_change"
  | "manage_menu"
  | "view_analytics"
  | "manage_sale_sessions"
  | "automatic_cash_admin"
  | "counter_mode"
  | "fiscal_operations";

export type AuthUser = {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  roleLabel: string;
  permissions: AuthPermission[];
  allowedPaymentMethodIds?: string[];
};

export type LoginResponse =
  | { ok: true; token: string; user: AuthUser; sessionStartedAt: number }
  | { ok: false; error: string };
