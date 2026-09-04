import { useEffect, useState } from "react";
import {
  acquireTableLock,
  dispatchTableLockConflict,
  isTableLockConflictError,
  isTableLockTransportUnavailable,
  isValidTableLockSession,
  registerActiveTableLock,
  releaseTableLock,
  startTableLockHeartbeat,
  toTableLockConflictDetail,
  type TableLockConflictDetail,
  type TableLockPurpose,
  type TableLockSession,
} from "../../../../api/tableLocks";

export type TableLockStatus =
  | "idle"
  | "acquiring"
  | "locked"
  | "offline"
  | "conflict"
  | "lost"
  | "error";

export type TableLockState = {
  status: TableLockStatus;
  pending: boolean;
  error: string | null;
};

type UseTableLockOptions = {
  enabled: boolean;
  tableId?: string | null;
  session: TableLockSession;
  purpose: TableLockPurpose;
  allowOfflineContinuation?: boolean;
  onConflict?: (detail: TableLockConflictDetail) => void;
  onError?: (message: string) => void;
};

const idleState: TableLockState = {
  status: "idle",
  pending: false,
  error: null,
};

export function useTableLock({
  enabled,
  tableId,
  session,
  purpose,
  allowOfflineContinuation = false,
  onConflict,
  onError,
}: UseTableLockOptions): TableLockState {
  const [state, setState] = useState<TableLockState>(idleState);

  useEffect(() => {
    const normalizedTableId = String(tableId || "").trim();
    if (!enabled || !normalizedTableId || !isValidTableLockSession(session)) {
      setState(idleState);
      return;
    }
    if (
      allowOfflineContinuation &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      setState({ status: "offline", pending: false, error: null });
      return;
    }

    let cancelled = false;
    let acquired = false;
    let released = false;
    let heartbeat: number | null = null;
    let unregister: (() => void) | null = null;

    const release = async () => {
      if (released) return;
      released = true;
      if (heartbeat !== null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
      if (!acquired) return;
      await releaseTableLock(session, normalizedTableId, purpose, { keepalive: true });
    };

    setState({ status: "acquiring", pending: true, error: null });

    acquireTableLock(session, normalizedTableId, purpose)
      .then(() => {
        if (cancelled) {
          void releaseTableLock(session, normalizedTableId, purpose, { keepalive: true });
          return;
        }
        acquired = true;
        heartbeat = startTableLockHeartbeat(session, [normalizedTableId], purpose, {
          onLost: (detail, error) => {
            if (cancelled) return;
            unregister?.();
            void release();
            if (allowOfflineContinuation && isTableLockTransportUnavailable(error)) {
              setState({ status: "offline", pending: false, error: null });
              return;
            }
            dispatchTableLockConflict(detail);
            onConflict?.(detail);
            setState({ status: "lost", pending: false, error: detail.message });
          },
        });
        unregister = registerActiveTableLock({
          tableIds: [normalizedTableId],
          purpose,
          session,
          release,
        });
        setState({ status: "locked", pending: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (allowOfflineContinuation && isTableLockTransportUnavailable(error)) {
          setState({ status: "offline", pending: false, error: null });
          return;
        }
        const detail = toTableLockConflictDetail(error, normalizedTableId, purpose);
        const message = error instanceof Error ? error.message : detail.message;

        if (isTableLockConflictError(error)) {
          dispatchTableLockConflict(detail);
          onConflict?.(detail);
          setState({ status: "conflict", pending: false, error: detail.message });
          return;
        }

        onError?.(message);
        setState({ status: "error", pending: false, error: message });
      });

    return () => {
      cancelled = true;
      unregister?.();
      void release();
    };
  }, [allowOfflineContinuation, enabled, onConflict, onError, purpose, session, tableId]);

  return state;
}
