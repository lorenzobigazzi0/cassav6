import {
  FIRST_REMINDER_KEY,
  readReservationReminderValue,
  REMINDER_ENABLED_KEY,
  SECOND_REMINDER_KEY,
  writeReservationReminderValue,
} from "../shared/storage/reservationReminderStorage";

export type ReservationReminderPreferences = {
  enabled: boolean;
  firstLeadMinutes: number;
  secondLeadMinutes: number;
};

const REMINDER_EVENT = "reservation_reminders_changed";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readNumber = (key: string, fallback: number) => {
  if (typeof window === "undefined") return fallback;
  const raw = readReservationReminderValue(key);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.round(value);
};

const normalize = (prefs: ReservationReminderPreferences): ReservationReminderPreferences => {
  const first = clamp(Math.round(prefs.firstLeadMinutes || 15), 1, 240);
  const second = clamp(Math.round(prefs.secondLeadMinutes || 5), 1, 240);
  const orderedFirst = Math.max(first, second + 1);
  const orderedSecond = Math.min(second, orderedFirst - 1);
  return {
    enabled: prefs.enabled,
    firstLeadMinutes: orderedFirst,
    secondLeadMinutes: orderedSecond,
  };
};

export const getReservationReminderPreferences = (): ReservationReminderPreferences => {
  if (typeof window === "undefined") {
    return { enabled: true, firstLeadMinutes: 15, secondLeadMinutes: 5 };
  }
  const enabledRaw = readReservationReminderValue(REMINDER_ENABLED_KEY);
  const enabled = enabledRaw === null ? true : enabledRaw === "1";
  const firstLeadMinutes = readNumber(FIRST_REMINDER_KEY, 15);
  const secondLeadMinutes = readNumber(SECOND_REMINDER_KEY, 5);
  return normalize({ enabled, firstLeadMinutes, secondLeadMinutes });
};

export const setReservationReminderPreferences = (prefs: ReservationReminderPreferences) => {
  if (typeof window === "undefined") return;
  const normalized = normalize(prefs);
  writeReservationReminderValue(REMINDER_ENABLED_KEY, normalized.enabled ? "1" : "0");
  writeReservationReminderValue(FIRST_REMINDER_KEY, String(normalized.firstLeadMinutes));
  writeReservationReminderValue(SECOND_REMINDER_KEY, String(normalized.secondLeadMinutes));
  window.dispatchEvent(new Event(REMINDER_EVENT));
};

export const subscribeReservationReminderPreferences = (handler: () => void) => {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(REMINDER_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(REMINDER_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
};
