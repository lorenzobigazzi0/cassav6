import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const PIN_SCRYPT_N = 32768;
const PIN_SCRYPT_R = 8;
const PIN_SCRYPT_P = 1;
const PIN_KEY_LEN = 64;
const PIN_SALT_LEN = 16;
const PIN_SCRYPT_MAXMEM = 128 * 1024 * 1024;

export function hashPin(pin) {
  const saltHex = randomBytes(PIN_SALT_LEN).toString("hex");
  const derived = scryptSync(pin, Buffer.from(saltHex, "hex"), PIN_KEY_LEN, {
    N: PIN_SCRYPT_N,
    r: PIN_SCRYPT_R,
    p: PIN_SCRYPT_P,
    maxmem: PIN_SCRYPT_MAXMEM,
  });
  return `scrypt$${PIN_SCRYPT_N}$${PIN_SCRYPT_R}$${PIN_SCRYPT_P}$${saltHex}$${derived.toString("hex")}`;
}

export function parsePinHash(pinHash) {
  if (typeof pinHash !== "string") return null;

  const parts = pinHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  const saltHex = parts[4];
  const hashHex = parts[5];

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length % 2 !== 0) return null;

  return { N, r, p, saltHex, hashHex };
}

export function verifyPin(pin, pinHash) {
  const parsed = parsePinHash(pinHash);
  if (!parsed) return false;

  try {
    const expected = Buffer.from(parsed.hashHex, "hex");
    const derived = scryptSync(pin, Buffer.from(parsed.saltHex, "hex"), expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: PIN_SCRYPT_MAXMEM,
    });

    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export async function verifyPinAsync(pin, pinHash) {
  const parsed = parsePinHash(pinHash);
  if (!parsed) return false;

  try {
    const expected = Buffer.from(parsed.hashHex, "hex");
    const derived = await new Promise((resolve, reject) => {
      scrypt(
        pin,
        Buffer.from(parsed.saltHex, "hex"),
        expected.length,
        {
          N: parsed.N,
          r: parsed.r,
          p: parsed.p,
          maxmem: PIN_SCRYPT_MAXMEM,
        },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      );
    });

    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
