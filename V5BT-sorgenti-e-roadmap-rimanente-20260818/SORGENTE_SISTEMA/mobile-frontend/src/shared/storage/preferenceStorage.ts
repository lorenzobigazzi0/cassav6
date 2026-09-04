import {
  readDualStorageString,
  readLocalStorageString,
  readSessionStorageString,
  removeLocalStorageString,
  removeSessionStorageString,
  writeDualStorageString,
  writeLocalStorageString,
  writeSessionStorageString,
} from "./storageAdapter";

export function readLocalPreference(key: string) {
  return readLocalStorageString(key);
}

export function writeLocalPreference(key: string, value: string) {
  writeLocalStorageString(key, value);
}

export function removeLocalPreference(key: string) {
  removeLocalStorageString(key);
}

export function readSessionPreference(key: string) {
  return readSessionStorageString(key);
}

export function writeSessionPreference(key: string, value: string) {
  writeSessionStorageString(key, value);
}

export function removeSessionPreference(key: string) {
  removeSessionStorageString(key);
}

export function readDualPreference(key: string) {
  return readDualStorageString(key);
}

export function writeDualPreference(key: string, value: string) {
  writeDualStorageString(key, value);
}
