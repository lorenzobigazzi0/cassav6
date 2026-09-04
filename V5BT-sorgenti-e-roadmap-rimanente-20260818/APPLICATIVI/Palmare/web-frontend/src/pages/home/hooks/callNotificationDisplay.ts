import type { ServerNotification } from "../../../api/notifications";
import type { CallNotification } from "../types";

const DESCRIPTION_LIMIT = 140;
const WAITER_CALL_TITLE = "Chiamata cameriere";

const textValue = (value: unknown) => String(value ?? "").trim();

const comparableText = (value: unknown) =>
  textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const isSamePersonText = (value: string, reference: string) => {
  const normalizedValue = comparableText(value);
  const normalizedReference = comparableText(reference);
  if (!normalizedValue || !normalizedReference) return false;
  return normalizedValue === normalizedReference || normalizedValue.includes(normalizedReference);
};

const recipientTexts = (meta: Record<string, unknown>) =>
  [meta.waiter, meta.targetFullName, meta.targetUsername, meta.targetUserId]
    .map(textValue)
    .filter(Boolean);

const firstNonRecipientText = (
  meta: Record<string, unknown>,
  candidates: unknown[]
) => {
  const recipients = recipientTexts(meta);
  return (
    candidates
      .map(textValue)
      .find((candidate) => {
        if (!candidate) return false;
        return !recipients.some((recipient) => isSamePersonText(candidate, recipient));
      }) ?? ""
  );
};

const formatStation = (value: unknown) => {
  const raw = textValue(value)
    .replace(/^(postazione|station)\s*[:#-]?\s*/i, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  return /^[a-z0-9-]+$/i.test(raw) ? raw.toUpperCase() : raw;
};

const stationFromFeedbackConsumer = (value: unknown) => {
  const parts = textValue(value)
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const prefixIndex = parts.findIndex(
    (part) =>
      part.toLowerCase() === "postazione" ||
      part.toLowerCase().includes("postazione-waiter-call-feedback")
  );
  if (prefixIndex < 0) return "";
  return formatStation(parts[prefixIndex + 1]);
};

const isGenericWaiterTitle = (title: string) => {
  const normalized = comparableText(title);
  return !normalized || normalized === comparableText(WAITER_CALL_TITLE);
};

const resolveRequesterName = (meta: Record<string, unknown>) =>
  firstNonRecipientText(meta, [
    meta.requestedBy,
    meta.requesterFullName,
    meta.requesterName,
    meta.requesterUsername,
    meta.callerFullName,
    meta.callerName,
    meta.callerUsername,
    meta.operatorName,
    meta.operatorUsername,
    meta.createdByFullName,
    meta.createdByUsername,
    meta.sourceUserFullName,
    meta.sourceUsername,
    meta.fromFullName,
    meta.fromUsername,
  ]);

const resolveStation = (meta: Record<string, unknown>, title: string) => {
  const explicitStation = [
    meta.requesterStation,
    meta.requesterStationName,
    meta.sourceStation,
    meta.sourceStationName,
    meta.station,
    meta.stationName,
    meta.workstation,
    meta.workstationId,
    meta.deviceName,
  ]
    .map(formatStation)
    .find(Boolean);
  if (explicitStation) return explicitStation;

  const feedbackStation = stationFromFeedbackConsumer(meta.requesterFeedbackConsumer);
  if (feedbackStation) return feedbackStation;

  if (!isGenericWaiterTitle(title)) return formatStation(title);
  return "";
};

const trimDescription = (description: string) => description.trim().slice(0, DESCRIPTION_LIMIT);

const optionalText = (value: unknown) => textValue(value) || undefined;

const buildWaiterCallNotification = (item: ServerNotification): CallNotification => {
  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  const requesterName = resolveRequesterName(meta);
  const station = resolveStation(meta, item.title);
  const caller = requesterName || "Operatore";
  const stationLabel = station || "non indicata";
  const message = `Chiamata da ${caller} alla postazione ${stationLabel}`;

  return {
    id: item.id,
    type: "waiter",
    title: trimDescription(message),
    description: "",
    createdAt: item.createdAt,
    confirmed: false,
  };
};

export const toCallNotification = (item: ServerNotification): CallNotification => {
  if (item.type === "waiter") return buildWaiterCallNotification(item);
  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  return {
    id: item.id,
    type: "bell",
    title: item.title,
    description: trimDescription(item.description),
    createdAt: item.createdAt,
    confirmed: false,
    orderId: optionalText(meta.orderId),
    sourceNotificationId: optionalText(meta.sourceNotificationId),
  };
};
