import { useEffect } from "react";
import { installMobilePaymentSessionRuntime } from "../../utils/paymentSessionRuntime";

/**
 * Owns the payment-session runtime lifecycle from React root instead of main.tsx.
 * The runtime logic (beforeunload/focus/pageshow/storage/visibility listeners and
 * persist/restore sync) is unchanged and lives in utils/paymentSessionRuntime; the
 * install is idempotent via its own module guard, so this hook only relocates the
 * call. authStore.setAuth/logout already drive restore/persist.
 */
export function usePaymentSessionRuntime() {
  useEffect(() => {
    installMobilePaymentSessionRuntime();
  }, []);
}
