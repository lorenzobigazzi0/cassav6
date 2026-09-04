const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalizeKey = (value) => normalizeText(value).toLowerCase();

function collectOrderWaiterIdentity(order) {
  const ids = new Set();
  const usernames = new Set();
  const names = new Set();

  [
    order?.createdByUserId,
    order?.waiterUserId,
    order?.ownerUserId,
    order?.operatorUserId,
    order?.targetUserId,
  ].forEach((value) => {
    const key = normalizeText(value);
    if (key) ids.add(key);
  });

  [
    order?.createdByUsername,
    order?.waiterUsername,
    order?.ownerUsername,
    order?.operatorUsername,
    order?.targetUsername,
  ].forEach((value) => {
    const key = normalizeKey(value);
    if (key) usernames.add(key);
  });

  [
    order?.waiter,
    order?.createdByFullName,
    order?.ownerOperator,
    order?.operatorName,
    order?.targetFullName,
  ].forEach((value) => {
    const key = normalizeKey(value);
    if (key) names.add(key);
  });

  return { ids, usernames, names };
}

function waiterFullName(waiter) {
  const fullName = normalizeText(waiter?.fullName ?? waiter?.name ?? waiter?.displayName);
  if (fullName) return fullName;
  return normalizeText([waiter?.firstName, waiter?.lastName].filter(Boolean).join(" "));
}

function matchesWaiterIdentity(waiter, identity) {
  const waiterId = normalizeText(waiter?.userId ?? waiter?.id);
  if (waiterId && identity.ids.has(waiterId)) return true;

  const username = normalizeKey(waiter?.username ?? waiter?.userName ?? waiter?.login);
  if (username && identity.usernames.has(username)) return true;

  const fullName = normalizeKey(waiterFullName(waiter));
  return Boolean(fullName && identity.names.has(fullName));
}

export function resolveOrderWaiterAvailability(order, waiters) {
  const identity = collectOrderWaiterIdentity(order);
  const required = identity.ids.size > 0 || identity.usernames.size > 0 || identity.names.size > 0;
  if (!required) return { required: false, available: true, waiter: null };

  const waiter = (Array.isArray(waiters) ? waiters : []).find((entry) =>
    entry && typeof entry === "object" && matchesWaiterIdentity(entry, identity)
  ) || null;
  const available = Boolean(
    waiter && waiter.online !== false && waiter.activeNow !== false
  );

  return { required: true, available, waiter };
}
