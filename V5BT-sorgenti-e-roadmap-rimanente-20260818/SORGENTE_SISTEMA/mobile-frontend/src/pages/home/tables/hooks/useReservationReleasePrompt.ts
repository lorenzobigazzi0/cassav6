import { useCallback, useEffect, useRef, useState } from "react";
import type { DiningTable } from "../../../../api/tables";

export type ReservationReleasePrompt = {
  key: string;
  tableId: string;
  actionTableId: string;
  tableLabel: string;
  reservationAt: number;
  customerName: string;
  logicalContext: {
    logicalTableId?: string;
    logicalTableLabel?: string;
    tableLabel?: string;
  };
};

const RESERVATION_RELEASE_PROMPT_SNOOZE_MS = 10 * 60_000;

const buildReservationReleasePrompt = (
  table: DiningTable,
  roomId: string,
  now: number
): ReservationReleasePrompt | null => {
  const preview = table.reservationPreview;
  if (!preview?.shouldWarnRelease) return null;
  if (preview.reservationAt > now) return null;
  const actionTableId = table.mobileActiveTableId || table.id;
  return {
    key: `${roomId}|${table.id}|${preview.id}`,
    tableId: table.id,
    actionTableId,
    tableLabel: table.mobileComplexLabel || table.tableLabel || `Tavolo ${table.number}`,
    reservationAt: preview.reservationAt,
    customerName: preview.customerName || "prenotazione",
    logicalContext: {
      logicalTableId: table.logicalTableId,
      logicalTableLabel: table.logicalTableLabel,
      tableLabel: table.tableLabel,
    },
  };
};

export function useReservationReleasePrompt({
  enabled,
  now,
  roomId,
  tables,
}: {
  enabled: boolean;
  now: number;
  roomId: string;
  tables: DiningTable[];
}) {
  const [prompt, setPrompt] = useState<ReservationReleasePrompt | null>(null);
  const snoozeRef = useRef<Map<string, number>>(new Map());

  const resolvePrompt = useCallback(
    (table: DiningTable) => buildReservationReleasePrompt(table, roomId, now),
    [now, roomId]
  );

  useEffect(() => {
    if (!prompt) return;
    const stillDue = tables.some((table) => resolvePrompt(table)?.key === prompt.key);
    if (!stillDue) {
      setPrompt(null);
    }
  }, [prompt, resolvePrompt, tables]);

  useEffect(() => {
    if (!enabled || prompt) return;
    const nextPrompt =
      tables
        .map(resolvePrompt)
        .filter((item): item is ReservationReleasePrompt => Boolean(item))
        .filter((item) => (snoozeRef.current.get(item.key) ?? 0) <= now)
        .sort((left, right) => left.reservationAt - right.reservationAt)[0] ?? null;
    if (nextPrompt) {
      setPrompt(nextPrompt);
    }
  }, [enabled, now, prompt, resolvePrompt, tables]);

  const snoozePrompt = useCallback(() => {
    if (!prompt) return;
    snoozeRef.current.set(prompt.key, Date.now() + RESERVATION_RELEASE_PROMPT_SNOOZE_MS);
    setPrompt(null);
  }, [prompt]);

  return { prompt, snoozePrompt };
}
