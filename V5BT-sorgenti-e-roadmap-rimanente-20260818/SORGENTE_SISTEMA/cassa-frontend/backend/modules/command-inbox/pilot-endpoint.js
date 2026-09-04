// Step 4 — Command Inbox Pilot Endpoints.
//
// Wrapper idempotente che avvolge gli handler HTTP a basso rischio
// (notification.ack, print.request non fiscale) per renderli sicuri contro
// retry / doppio-tap / reconnect senza toccare la loro logica business.
//
// Il modulo e' completamente iniettabile (nessun import da server.js) cosi' e'
// testabile in isolamento con fake `req`/`res`/repository.
//
// Contratto client: la richiesta partecipa alla command inbox solo se porta
// SIA un request id SIA una idempotency key (header `x-command-request-id` /
// `x-idempotency-key`, oppure `requestId` / `idempotencyKey` nel body). Senza
// questi campi il wrapper delega direttamente all'handler legacy: i client
// attuali restano invariati (rollback naturale, zero rischio).

const ENFORCING_MODES = new Set(["enforce_pilot", "enforce", "write"]);

function normalizeIdentifier(value) {
  return String(value ?? "").trim();
}

function clampStatus(value, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 599) return fallback;
  return parsed;
}

function tryParseJson(value) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// Proxy `res` che registra status + body senza scrivere sul socket reale. Copre
// la superficie usata da sendJson (statusCode/setHeader/end) piu' i metodi HTTP
// piu' comuni, cosi' un handler che dovesse usare writeHead/write non rompe.
function createResponseCapture() {
  const state = { statusCode: 200, headers: {}, body: undefined, ended: false };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value) {
      state.statusCode = clampStatus(value, state.statusCode);
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return state.headers[String(name).toLowerCase()];
    },
    removeHeader(name) {
      delete state.headers[String(name).toLowerCase()];
    },
    writeHead(status, headers) {
      state.statusCode = clampStatus(status, state.statusCode);
      if (headers && typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) {
          state.headers[String(key).toLowerCase()] = value;
        }
      }
      return res;
    },
    write() {
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        state.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
      state.ended = true;
      return res;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    emit() {
      return false;
    },
  };
  return { res, state };
}

export function createCommandInboxPilot(dependencies = {}) {
  const {
    getRepository,
    runtimeMetrics = null,
    nowIso = () => new Date().toISOString(),
    sendJson,
    readJsonBody,
    readHeaderValue,
    resolveMode = () => "off",
    ttlMs = 10 * 60 * 1000,
    isProduction = false,
    logger = console,
  } = dependencies;

  if (typeof getRepository !== "function") {
    throw new Error("createCommandInboxPilot richiede getRepository().");
  }
  if (typeof sendJson !== "function") {
    throw new Error("createCommandInboxPilot richiede sendJson().");
  }
  if (typeof readJsonBody !== "function") {
    throw new Error("createCommandInboxPilot richiede readJsonBody().");
  }
  if (typeof readHeaderValue !== "function") {
    throw new Error("createCommandInboxPilot richiede readHeaderValue().");
  }

  function recordMetric(commandType, startedAtMs) {
    if (!runtimeMetrics || typeof runtimeMetrics.recordOperation !== "function") return;
    try {
      runtimeMetrics.recordOperation("commandInbox", commandType, Date.now() - startedAtMs);
    } catch {
      // metriche best-effort: non devono mai rompere la richiesta
    }
  }

  function extractRequestId(req, payload) {
    return (
      normalizeIdentifier(readHeaderValue(req, "x-command-request-id")) ||
      normalizeIdentifier(payload?.requestId ?? payload?.request_id)
    );
  }

  function extractIdempotencyKey(req, payload) {
    return (
      normalizeIdentifier(readHeaderValue(req, "x-idempotency-key")) ||
      normalizeIdentifier(payload?.idempotencyKey ?? payload?.idempotency_key)
    );
  }

  function extractDeviceId(req, payload) {
    return (
      normalizeIdentifier(readHeaderValue(req, "x-device-uuid")) ||
      normalizeIdentifier(payload?.deviceUuid ?? payload?.deviceId ?? payload?.device_id) ||
      "pilot-device"
    );
  }

  function buildErrorBody(error, status) {
    const message =
      status >= 500 && isProduction
        ? "Errore interno."
        : error instanceof Error && error.message
          ? error.message
          : "Errore interno.";
    const body = { ok: false, error: message };
    const code = normalizeIdentifier(error?.code);
    if (code) body.code = code;
    if (error?.details && typeof error.details === "object") body.details = error.details;
    return body;
  }

  function replayStoredResult(res, record) {
    const result = record?.result && typeof record.result === "object" ? record.result : {};
    const status = clampStatus(result.status, 200);
    const json =
      result.json && typeof result.json === "object"
        ? result.json
        : { ok: true, replayed: true };
    sendJson(res, status, json);
  }

  function wrap(commandType, handler, options = {}) {
    const shouldEngage = typeof options.shouldEngage === "function" ? options.shouldEngage : () => true;
    const selectIdempotencyPayload =
      typeof options.selectIdempotencyPayload === "function"
        ? options.selectIdempotencyPayload
        : (payload) => payload;
    const resolveAggregate =
      typeof options.aggregate === "function" ? options.aggregate : () => ({});

    return async function commandInboxPilotHandler(req, res, ...rest) {
      const mode = normalizeIdentifier(resolveMode()).toLowerCase() || "off";
      if (mode === "off") {
        return handler(req, res, ...rest);
      }

      let repo = null;
      try {
        repo = await getRepository();
      } catch (error) {
        logger?.warn?.(
          `[command-inbox] repository non disponibile per ${commandType}: ${error?.message || error}`,
        );
      }
      if (!repo) {
        return handler(req, res, ...rest);
      }

      let payload = {};
      try {
        payload = await readJsonBody(req);
      } catch {
        // body invalido: lascia gestire l'errore all'handler/dispatch legacy
        return handler(req, res, ...rest);
      }

      if (!shouldEngage(payload)) {
        return handler(req, res, ...rest);
      }

      const requestId = extractRequestId(req, payload);
      const idempotencyKey = extractIdempotencyKey(req, payload);
      if (!requestId || !idempotencyKey) {
        // Client legacy senza idempotenza: path invariato.
        return handler(req, res, ...rest);
      }

      const enforce = ENFORCING_MODES.has(mode);
      const startedAtMs = Date.now();
      const aggregate = resolveAggregate(payload) || {};

      let claim = null;
      try {
        claim = repo.begin({
          requestId,
          idempotencyKey,
          deviceId: extractDeviceId(req, payload),
          userId: normalizeIdentifier(payload?.userId ?? payload?.user_id) || null,
          stationId:
            normalizeIdentifier(payload?.station ?? payload?.stationId ?? payload?.station_id) || null,
          commandType,
          aggregateType: normalizeIdentifier(aggregate.aggregateType) || null,
          aggregateId: normalizeIdentifier(aggregate.aggregateId) || null,
          payload: selectIdempotencyPayload(payload),
          expiresAt: new Date(Date.parse(nowIso()) + ttlMs).toISOString(),
        });
      } catch (error) {
        // Chiave/id non validi o errore inbox: non deve mai bloccare l'endpoint.
        logger?.warn?.(
          `[command-inbox] begin fallito per ${commandType}, fallback legacy: ${error?.message || error}`,
        );
        return handler(req, res, ...rest);
      }

      // Duplicato osservato/gestito.
      if (claim.state !== "created") {
        recordMetric(commandType, startedAtMs);
        if (!enforce) {
          // shadow: nessun short-circuit, esecuzione live invariata.
          return handler(req, res, ...rest);
        }
        if (claim.state === "conflict") {
          return sendJson(res, 409, {
            ok: false,
            error: "Stessa idempotency key con payload diverso.",
            code: "COMMAND_PAYLOAD_CONFLICT",
          });
        }
        if (claim.state === "processing") {
          if (typeof res.setHeader === "function") res.setHeader("Retry-After", "1");
          return sendJson(res, 409, {
            ok: false,
            error: "Comando ancora in elaborazione.",
            code: "COMMAND_IN_PROGRESS",
          });
        }
        // committed | rejected | failed → replay del risultato salvato.
        return replayStoredResult(res, claim.record);
      }

      // Primo arrivo del comando: esegue l'handler catturando la risposta.
      const { res: captureRes, state } = createResponseCapture();
      let handlerError = null;
      try {
        await handler(req, captureRes, ...rest);
      } catch (error) {
        handlerError = error;
      }
      recordMetric(commandType, startedAtMs);

      if (handlerError) {
        const status = handlerError.status ? clampStatus(handlerError.status, 500) : 500;
        const body = buildErrorBody(handlerError, status);
        try {
          if (status >= 500) {
            repo.fail(requestId, body.code || "COMMAND_FAILED", { status, json: body });
          } else {
            repo.reject(requestId, body.code || "COMMAND_REJECTED", { status, json: body });
          }
        } catch (memoError) {
          logger?.warn?.(
            `[command-inbox] memo errore ${commandType} fallita: ${memoError?.message || memoError}`,
          );
        }
        throw handlerError;
      }

      const status = clampStatus(state.statusCode, 200);
      const json = tryParseJson(state.body);
      const storedResult = { status, json: json ?? null };
      try {
        if (status >= 400) {
          repo.reject(requestId, `HTTP_${status}`, storedResult);
        } else {
          repo.commit(requestId, storedResult);
        }
      } catch (memoError) {
        logger?.warn?.(
          `[command-inbox] memo esito ${commandType} fallita: ${memoError?.message || memoError}`,
        );
      }

      if (json !== undefined) {
        sendJson(res, status, json);
      } else if (state.body !== undefined) {
        // Corpo non-JSON: rispedisci grezzo mantenendo lo status.
        res.statusCode = status;
        res.end(state.body);
      } else {
        sendJson(res, status, { ok: true });
      }
      return undefined;
    };
  }

  return { wrap };
}
