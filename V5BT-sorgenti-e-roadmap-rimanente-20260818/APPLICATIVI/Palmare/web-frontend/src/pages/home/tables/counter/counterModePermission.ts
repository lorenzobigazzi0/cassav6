import type { AuthUser } from "../../../../types/auth";

type UserLike =
  | Pick<AuthUser, "role" | "permissions">
  | {
      role?: string | null;
      permissions?: string[] | null;
      flags?: Record<string, unknown> | null;
    }
  | null
  | undefined;

export function canUseCounterMode(user: UserLike): boolean {
  if (!user) return false;
  if (String(user.role ?? "").toLowerCase() === "admin") return true;
  if (Array.isArray(user.permissions) && user.permissions.includes("counter_mode")) return true;
  if ("flags" in user && user.flags?.canUseCounterMode === true) return true;
  return false;
}
