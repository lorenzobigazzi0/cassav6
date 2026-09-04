import { timingSafeEqual } from "node:crypto";

const APPROVE_PATH = "/api/pos/room-change/approve";
const METRIC_KIND = "posRoomChangeApprovePreLane";

function safeString(value) {
  return String(value ?? "").trim();
}

function safeSecretEqual(left, right) {
  const leftBuffer = Buffer.from(safeString(left), "utf8");
  const rightBuffer = Buffer.from(safeString(right), "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function buildUserSnapshot(user, options) {
  if (!user || typeof user !== "object") return null;
  const userId = safeString(user.id);
  const username = options.normalizeUsername(user.username);
  const pinHash = safeString(user.pinHash);
  if (!userId || !username || !pinHash) return null;
  return Object.freeze({
    userId,
    username,
    pinHash,
    role: options.normalizeRole(user.role),
    privileged: options.isPrivilegedRole(user.role) === true,
  });
}

function findApprover(users, username, normalizeUsername) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || !Array.isArray(users)) return null;
  return users.find((entry) => normalizeUsername(entry?.username) === normalizedUsername) ?? null;
}

export function createRoomChangeApprovePinProofService(options = {}) {
  const enabled = options.enabled === true;
  const proofProperty = Symbol("roomChangeApprovePinProof");
  const normalizeUsername = options.normalizeUsername ?? ((value) => safeString(value).toLowerCase());
  const normalizeRole = options.normalizeRole ?? ((value) => safeString(value).toLowerCase());
  const isPrivilegedRole = options.isPrivilegedRole ?? (() => false);
  const record = (label, durationMs = 0) => {
    options.runtimeMetrics?.recordOperation?.(METRIC_KIND, label, Math.max(0, Number(durationMs) || 0));
  };
  const measure = async (label, operation) => {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      record(label, Date.now() - startedAt);
    }
  };

  function shouldPrepare(req, pathname) {
    return enabled &&
      safeString(req?.method).toUpperCase() === "POST" &&
      safeString(pathname) === APPROVE_PATH;
  }

  async function prepare(req, pathname) {
    if (!shouldPrepare(req, pathname)) return { prepared: false, reason: "disabled_or_path" };
    const startedAt = Date.now();
    try {
      const payload = req?.__jsonBodyPayload && typeof req.__jsonBodyPayload === "object"
        ? req.__jsonBodyPayload
        : {};
      const requestId = safeString(payload.requestId);
      const approverUsername = safeString(payload.approverUsername);
      const approverPin = safeString(payload.approverPin);
      const deviceUuid = safeString(payload.deviceUuid);
      if (!requestId || !approverUsername || !approverPin || !deviceUuid) {
        record("skip.invalidPayload");
        return { prepared: false, reason: "invalid_payload" };
      }

      const db = await measure("readDb", () => options.readDb());
      const approver = findApprover(db?.users, approverUsername, normalizeUsername);
      if (!approver) {
        record("skip.userMissing");
        return { prepared: false, reason: "user_missing" };
      }
      const snapshot = buildUserSnapshot(approver, {
        normalizeUsername,
        normalizeRole,
        isPrivilegedRole,
      });
      if (!snapshot) {
        record("skip.invalidUserSnapshot");
        return { prepared: false, reason: "invalid_user_snapshot" };
      }

      const pinValid = await measure("pinVerify", () => options.verifyPinAsync(approverPin, snapshot.pinHash));
      const proof = Object.freeze({ version: 1, ...snapshot, pinValid: pinValid === true });
      Object.defineProperty(req, proofProperty, {
        configurable: true,
        enumerable: false,
        value: proof,
        writable: false,
      });
      record(pinValid ? "prepared.validPin" : "prepared.invalidPin");
      return { prepared: true };
    } catch {
      record("skip.error");
      return { prepared: false, reason: "error" };
    } finally {
      record("total", Date.now() - startedAt);
    }
  }

  function consume(req, approver, approverUsername) {
    if (!enabled) return { usable: false, reason: "disabled" };
    const proof = req?.[proofProperty];
    if (req && proof) delete req[proofProperty];
    if (!proof || proof.version !== 1) {
      record("consume.missing");
      return { usable: false, reason: "missing" };
    }
    const current = buildUserSnapshot(approver, {
      normalizeUsername,
      normalizeRole,
      isPrivilegedRole,
    });
    if (!current) {
      record("consume.staleUser");
      return { usable: false, reason: "user" };
    }
    if (proof.userId !== current.userId || proof.username !== normalizeUsername(approverUsername) || proof.username !== current.username) {
      record("consume.staleIdentity");
      return { usable: false, reason: "identity" };
    }
    if (!safeSecretEqual(proof.pinHash, current.pinHash)) {
      record("consume.stalePinHash");
      return { usable: false, reason: "pin_hash" };
    }
    if (proof.role !== current.role || proof.privileged !== current.privileged) {
      record("consume.staleRole");
      return { usable: false, reason: "role" };
    }
    record(proof.pinValid ? "consume.validPin" : "consume.invalidPin");
    return { usable: true, pinValid: proof.pinValid };
  }

  function discard(req) {
    if (req?.[proofProperty]) delete req[proofProperty];
  }

  return Object.freeze({ enabled, shouldPrepare, prepare, consume, discard });
}
