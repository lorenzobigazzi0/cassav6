export function shouldPullStationNotificationsForReason(reason) {
  const value = String(reason || "")
    .trim()
    .toLowerCase();
  return (
    value.startsWith("notification_") ||
    value.startsWith("waiter_") ||
    value.startsWith("bell_")
  );
}
