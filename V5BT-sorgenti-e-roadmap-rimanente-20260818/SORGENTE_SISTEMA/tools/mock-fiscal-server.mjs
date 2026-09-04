import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const HOST = process.env.MOCK_FISCAL_HOST || "127.0.0.1";
const PORT = Number(process.env.MOCK_FISCAL_PORT || 9290);

let statusRequests = 0;
let verifyRequests = 0;
let receiptRequests = 0;
let reprintRequests = 0;
let voidRequests = 0;
const issuedByIdempotencyKey = new Map();
const voidedByIdempotencyKey = new Map();

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,idempotency-key,x-fiscal-device-id,x-operator-id,x-operator-name",
  });
  response.end(JSON.stringify(payload));
};

const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
  });

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,idempotency-key,x-fiscal-device-id,x-operator-id,x-operator-name",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/api/fiscal/status") {
    statusRequests += 1;
    sendJson(response, 200, {
      ok: true,
      fiscalApiEnabled: true,
      provider: "mock-fiscal-local",
      status: "ready",
    });
    return;
  }

  if (
    request.method === "POST" &&
    request.url === "/api/fiscal/receipt/verify"
  ) {
    verifyRequests += 1;
    const body = await readBody(request);
    const operation =
      String(body?.operation ?? "").trim().toLowerCase() === "void"
        ? "void"
        : "issue";
    const idempotencyKey = String(
      body?.idempotencyKey ?? request.headers["idempotency-key"] ?? ""
    ).trim();
    if (!idempotencyKey) {
      sendJson(response, 400, {
        ok: false,
        error: "idempotency_key_required",
      });
      return;
    }
    const document =
      operation === "void"
        ? voidedByIdempotencyKey.get(idempotencyKey)
        : issuedByIdempotencyKey.get(idempotencyKey);
    sendJson(response, 200, {
      ok: true,
      authoritative: true,
      operation,
      idempotencyKey,
      found: Boolean(document),
      state: document
        ? operation === "void"
          ? "VOIDED"
          : "ISSUED"
        : "NOT_FOUND",
      ...(document ? { document } : {}),
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/fiscal/receipt") {
    receiptRequests += 1;
    await readBody(request);
    const idempotencyKey = String(
      request.headers["idempotency-key"] ?? ""
    ).trim();
    const existing = idempotencyKey
      ? issuedByIdempotencyKey.get(idempotencyKey)
      : null;
    if (existing) {
      sendJson(response, 200, {
        ok: true,
        idempotent: true,
        ...existing,
        message: `Documento ${existing.documentNumber} gia emesso dal simulatore locale.`,
      });
      return;
    }
    const suffix = String(receiptRequests).padStart(4, "0");
    const document = {
      fiscalDocNo: `MOCK-${suffix}`,
      documentNumber: `MOCK-${suffix}`,
      fiscalProviderRef: `MOCK-${suffix}`,
      fiscalMovementId: `MF-${randomUUID().slice(0, 8).toUpperCase()}`,
    };
    if (idempotencyKey) {
      issuedByIdempotencyKey.set(idempotencyKey, document);
    }
    sendJson(response, 200, {
      ok: true,
      ...document,
      message: `Documento fiscale MOCK-${suffix} emesso dal simulatore locale.`,
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/fiscal/reprint") {
    reprintRequests += 1;
    await readBody(request);
    sendJson(response, 200, {
      ok: true,
      fiscalProviderRef: `MOCK-REPRINT-${String(reprintRequests).padStart(4, "0")}`,
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/fiscal/void") {
    voidRequests += 1;
    await readBody(request);
    const idempotencyKey = String(
      request.headers["idempotency-key"] ?? ""
    ).trim();
    const existing = idempotencyKey
      ? voidedByIdempotencyKey.get(idempotencyKey)
      : null;
    if (existing) {
      sendJson(response, 200, {
        ok: true,
        idempotent: true,
        ...existing,
        message: `Annullamento ${existing.documentNumber} gia emesso dal simulatore locale.`,
      });
      return;
    }
    const suffix = String(voidRequests).padStart(4, "0");
    const document = {
      documentNumber: `MOCK-VOID-${suffix}`,
      fiscalProviderRef: `MOCK-VOID-${suffix}`,
      fiscalMovementId: `MFV-${randomUUID().slice(0, 8).toUpperCase()}`,
    };
    if (idempotencyKey) {
      voidedByIdempotencyKey.set(idempotencyKey, document);
    }
    sendJson(response, 200, {
      ok: true,
      ...document,
      message: `Documento fiscale MOCK-VOID-${suffix} annullato dal simulatore locale.`,
    });
    return;
  }

  if (request.method === "GET" && request.url === "/metrics") {
    sendJson(response, 200, {
      statusRequests,
      verifyRequests,
      receiptRequests,
      reprintRequests,
      voidRequests,
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-fiscal] http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log(
    `[mock-fiscal] chiusura: status=${statusRequests}, verify=${verifyRequests}, receipt=${receiptRequests}, reprint=${reprintRequests}, void=${voidRequests}`
  );
  server.close(() => process.exit(0));
});
