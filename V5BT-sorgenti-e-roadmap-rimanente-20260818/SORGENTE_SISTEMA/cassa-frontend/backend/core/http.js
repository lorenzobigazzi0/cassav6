import { getAllowedCorsOrigins, IS_PRODUCTION } from "./config.js";
import { readHeaderValue } from "./security.js";

export class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    if (typeof options.code === "string" && options.code.trim().length > 0) {
      this.code = options.code.trim();
    }
    if (options.details && typeof options.details === "object") {
      this.details = options.details;
    }
  }
}

function isPrivateDevelopmentHostname(hostname) {
  const normalized = String(hostname ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  )
    return true;
  if (!normalized.includes(".") && !normalized.includes(":")) return true;
  if (normalized.startsWith("127.")) return true;
  if (normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;
  const match = normalized.match(/^172\.(\d{1,2})\./);
  if (match) {
    const secondOctet = Number(match[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }
  return false;
}

function isAllowedDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isPrivateDevelopmentHostname(url.hostname);
  } catch {
    return false;
  }
}

export function applySecurityHeaders(res) {
  if (!res || typeof res.setHeader !== "function") return;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
}

export function sendJson(res, status, payload) {
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function applyCors(req, res) {
  applySecurityHeaders(res);
  const origin = String(readHeaderValue(req, "origin") ?? "").trim();
  const allowedOrigins = getAllowedCorsOrigins();
  const allowAnyDevOrigin = !IS_PRODUCTION && allowedOrigins.length === 0;
  if (origin) {
    if (
      allowAnyDevOrigin ||
      allowedOrigins.includes(origin) ||
      (!IS_PRODUCTION && isAllowedDevelopmentOrigin(origin))
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
    } else {
      req.__corsRejected = true;
      res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
    }
  } else {
    res.setHeader("Vary", "Access-Control-Request-Headers");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  const allowHeaders = [
    "Accept",
    "Content-Type",
    "Authorization",
    "X-Client-App",
    "X-Device-Uuid",
    "X-User-Id",
    "X-Username",
    "X-Service-Token",
    "X-Smart-Card-Token",
    "X-Workflow-Pin-Reason",
  ];
  // Non riflettere Access-Control-Request-Headers: l'allowlist resta chiusa e revisionabile.
  res.setHeader("Access-Control-Allow-Headers", allowHeaders.join(", "));
  res.setHeader("Access-Control-Max-Age", "86400");
}

export async function readJsonBody(req, maxBodySize) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    let tooLarge = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += String(chunk);
      if (body.length > maxBodySize) {
        tooLarge = true;
        body = "";
        fail(new Error("Payload troppo grande."));
      }
    });

    req.on("end", () => {
      if (settled) return;
      if (!body) {
        done({});
        return;
      }
      try {
        done(JSON.parse(body));
      } catch {
        fail(new Error("JSON non valido."));
      }
    });

    req.on("error", (error) => {
      fail(error);
    });
  });
}
