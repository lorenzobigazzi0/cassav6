import { readLocalStorageString, writeLocalStorageString } from "./storageAdapter";

export const REMINDER_ENABLED_KEY = "settings_reservation_reminders_enabled";
export const FIRST_REMINDER_KEY = "settings_reservation_first_reminder_min";
export const SECOND_REMINDER_KEY = "settings_reservation_second_reminder_min";

export function readReservationReminderValue(key: string) {
  return readLocalStorageString(key);
}

export function writeReservationReminderValue(key: string, value: string) {
  writeLocalStorageString(key, value);
}
