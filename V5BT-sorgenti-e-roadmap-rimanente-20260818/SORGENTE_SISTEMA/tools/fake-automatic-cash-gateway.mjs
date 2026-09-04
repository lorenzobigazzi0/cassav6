import http from "node:http";

const HOST = process.env.FAKE_AUTOMATIC_CASH_HOST || "0.0.0.0";
const PORT = Number(process.env.FAKE_AUTOMATIC_CASH_PORT || 9090);
const DEPOSIT_TOTAL_CENTS = Number(process.env.FAKE_AUTOMATIC_CASH_DEPOSIT_TOTAL_CENTS || 2000);
const STOCK_PER_DENOMINATION = Math.max(
  1,
  Number(process.env.FAKE_AUTOMATIC_CASH_STOCK_PER_DENOMINATION || 120),
);

const sessions = new Set();
let activeOperation = null;
let deposit = null;

const cassettes = [
  { Value_Money: 2000, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 1000, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 500, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 200, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 100, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 50, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 20, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 10, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 5, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 2, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
  { Value_Money: 1, Stock: STOCK_PER_DENOMINATION, IsExist: true, IsEmpty: false },
];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Access-Control-Allow-Headers": "content-type,x-session-token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function snapshot() {
  return {
    ok: true,
    mode: "fake",
    activeOperation,
    deposit,
    inventory: {
      ok: true,
      listCassette: cassettes.map((cassette) => ({
        ...cassette,
        IsEmpty: cassette.Stock <= 0,
      })),
    },
    updatedAtMs: Date.now(),
  };
}

function requireSession(req) {
  const token = String(req.headers["x-session-token"] || "").trim();
  return token && sessions.has(token);
}

function decrementPieces(pieces) {
  const entries = Object.entries(pieces || {});
  for (const [rawCents, rawCount] of entries) {
    const cents = Number(rawCents);
    const count = Number(rawCount);
    const cassette = cassettes.find((entry) => entry.Value_Money === cents);
    if (!cassette || !Number.isInteger(count) || count <= 0 || cassette.Stock < count) {
      return false;
    }
  }
  for (const [rawCents, rawCount] of entries) {
    const cents = Number(rawCents);
    const count = Number(rawCount);
    const cassette = cassettes.find((entry) => entry.Value_Money === cents);
    cassette.Stock -= count;
  }
  return true;
}

function centsFromValue(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  return Math.max(0, Math.round(Number(fallback) || 0));
}

function readPaymentExpectedCents(body = {}) {
  return centsFromValue(
    body.expectedTotalCents ??
      body.totalDueCents ??
      body.amountDueCents ??
      body.totalToPayCents ??
      body.TotalToPayCents ??
      body.TotalToPay,
    0,
  );
}

function makeChangePieces(totalCents) {
  let remaining = centsFromValue(totalCents, 0);
  const pieces = {};
  const ordered = [...cassettes]
    .filter((cassette) => cassette.IsExist !== false)
    .sort((left, right) => right.Value_Money - left.Value_Money);
  for (const cassette of ordered) {
    if (remaining <= 0) break;
    const count = Math.min(
      cassette.Stock,
      Math.trunc(remaining / cassette.Value_Money),
    );
    if (count <= 0) continue;
    pieces[String(cassette.Value_Money)] = count;
    remaining -= cassette.Value_Money * count;
  }
  return remaining === 0 ? pieces : null;
}

function makeDepositMonitor(totalCents) {
  let remaining = centsFromValue(totalCents, 0);
  const rows = [];
  for (const cassette of [...cassettes].sort(
    (left, right) => right.Value_Money - left.Value_Money,
  )) {
    if (remaining <= 0) break;
    const quantity = Math.trunc(remaining / cassette.Value_Money);
    if (quantity <= 0) continue;
    rows.push({
      Value_Money: cassette.Value_Money,
      ReplenishmentStock: quantity,
    });
    remaining -= cassette.Value_Money * quantity;
  }
  return remaining === 0 ? rows : [];
}

function currentDepositTotalCents() {
  if (Number.isFinite(Number(deposit?.depositedTotalCents))) {
    return Math.max(0, Math.trunc(Number(deposit.depositedTotalCents)));
  }
  return DEPOSIT_TOTAL_CENTS > 0 ? DEPOSIT_TOTAL_CENTS : 0;
}

function availableDenominations() {
  return cassettes
    .filter((cassette) => cassette.IsExist !== false)
    .map((cassette) => ({
      cents: cassette.Value_Money,
      label: `${Math.trunc(cassette.Value_Money / 100)},${String(cassette.Value_Money % 100).padStart(2, "0")} EUR`,
      availablePieces: Math.max(0, cassette.Stock),
    }))
    .sort((left, right) => right.cents - left.cents);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && ["/", "/health", "/api/health", "/api/connection"].includes(path)) {
      return json(res, 200, { ok: true, service: "fake-automatic-cash-gateway", port: PORT });
    }
    if (req.method === "POST" && path === "/api/login") {
      const body = await readBody(req);
      const username = String(body.username || "operatore").trim() || "operatore";
      const token = `fake_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      sessions.add(token);
      return json(res, 200, {
        ok: true,
        token,
        user: { Id: 1, Username: username, FullName: username },
        mode: "FAKE",
      });
    }
    if (!requireSession(req)) return json(res, 401, { ok: false, error: "Sessione gateway richiesta." });

    if (req.method === "GET" && path === "/api/state") return json(res, 200, snapshot());
    if (req.method === "POST" && path === "/api/inventory/refresh") return json(res, 200, snapshot());
    if (req.method === "POST" && path === "/api/withdrawal/execute") {
      const body = await readBody(req);
      if (!decrementPieces(body.pieces)) {
        return json(res, 409, { ok: false, error: "Tagli insufficienti nel simulatore." });
      }
      activeOperation = {
        id: `fake_withdrawal_${Date.now()}`,
        type: "withdrawal",
        note: body.note || "",
        pieces: body.pieces || {},
        status: "waiting_removal",
        startedAtMs: Date.now(),
      };
      return json(res, 200, { ok: true, operation: activeOperation });
    }
    if (req.method === "POST" && path === "/api/withdrawal/remove") {
      activeOperation = null;
      return json(res, 200, { ok: true, removed: true });
    }
    if (req.method === "POST" && path === "/api/replenishment/start") {
      activeOperation = { id: `fake_deposit_${Date.now()}`, type: "replenishment", status: "active" };
      const depositedTotalCents = DEPOSIT_TOTAL_CENTS > 0 ? DEPOSIT_TOTAL_CENTS : 0;
      deposit = {
        depositedTotalCents,
        cassettesMonitor: makeDepositMonitor(depositedTotalCents),
        status: "active",
        startedAtMs: Date.now(),
      };
      return json(res, 200, { ok: true, operation: activeOperation });
    }
    if (req.method === "POST" && path === "/api/replenishment/close") {
      const depositedTotalCents = DEPOSIT_TOTAL_CENTS > 0 ? DEPOSIT_TOTAL_CENTS : 0;
      deposit = {
        ...(deposit || {}),
        depositedTotalCents,
        cassettesMonitor:
          deposit?.cassettesMonitor ?? makeDepositMonitor(depositedTotalCents),
        status: "closed",
        closedAtMs: Date.now(),
      };
      activeOperation = null;
      return json(res, 200, { ok: true, depositedTotalCents, deposit });
    }
    if (req.method === "POST" && path === "/api/replenishment/cancel") {
      activeOperation = null;
      deposit = deposit ? { ...deposit, status: "cancelled" } : null;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/cashin/start") {
      const body = await readBody(req);
      const typeOperation = body.typeOperation || "Cambio";
      const payment = String(typeOperation).toLowerCase() === "pagamento";
      const expectedTotalCents = payment ? readPaymentExpectedCents(body) : 0;
      activeOperation = {
        id: body.operationId || `fake_${payment ? "payment" : "change"}_${Date.now()}`,
        type: payment ? "payment" : "change",
        typeOperation,
        operationKind: body.operationKind || (payment ? "payment" : "change"),
        expectedTotalCents,
        note: body.note || "",
        status: "cashin",
        startedAtMs: Date.now(),
      };
      const depositedTotalCents = DEPOSIT_TOTAL_CENTS > 0 ? DEPOSIT_TOTAL_CENTS : 0;
      deposit = {
        depositedTotalCents,
        expectedTotalCents,
        changeDueCents: payment
          ? Math.max(0, depositedTotalCents - expectedTotalCents)
          : 0,
        status: "active",
        startedAtMs: Date.now(),
      };
      return json(res, 200, { ok: true, operation: activeOperation });
    }
    if (req.method === "GET" && path === "/api/cashin/deposit") {
      return json(res, 200, {
        ok: true,
        depositedTotalCents: currentDepositTotalCents(),
        deposit,
      });
    }
    if (req.method === "POST" && path === "/api/cashin/complete") {
      const body = await readBody(req);
      const payment = activeOperation?.type === "payment" ||
        String(body.typeOperation || "").toLowerCase() === "pagamento";
      const expectedTotalCents = payment
        ? readPaymentExpectedCents(body) || centsFromValue(activeOperation?.expectedTotalCents, 0)
        : 0;
      const depositedTotalCents = currentDepositTotalCents();
      const requestedChangeDueCents = centsFromValue(body.changeDueCents ?? body.ChangeDueCents ?? body.ChangeDue, 0);
      const changeDueCents = payment
        ? Math.max(requestedChangeDueCents, depositedTotalCents - expectedTotalCents, 0)
        : 0;
      let changePieces = {};
      if (payment && changeDueCents > 0) {
        changePieces = makeChangePieces(changeDueCents);
        if (!changePieces || !decrementPieces(changePieces)) {
          return json(res, 409, { ok: false, error: "Resto non disponibile nel simulatore." });
        }
      }
      deposit = deposit
        ? {
            ...deposit,
            expectedTotalCents,
            depositedTotalCents,
            changeDueCents,
            changePieces,
            status: "completed",
            completedAtMs: Date.now(),
          }
        : null;
      activeOperation = null;
      return json(res, 200, {
        ok: true,
        completed: true,
        expectedTotalCents,
        depositedTotalCents,
        changeDueCents,
        changePieces,
        deposit,
      });
    }
    if (req.method === "POST" && path === "/api/change/return-change") {
      const body = await readBody(req);
      return json(res, 200, {
        ok: true,
        TotalToChange: body.TotalToChange ?? body.totalToChangeCents,
        availableDenominations: availableDenominations(),
      });
    }
    if (req.method === "POST" && path === "/api/change/execute") {
      const body = await readBody(req);
      if (!decrementPieces(body.pieces)) {
        return json(res, 409, { ok: false, error: "Tagli insufficienti nel simulatore." });
      }
      activeOperation = {
        id: body.operationId || `fake_change_${Date.now()}`,
        type: "change",
        note: body.note || "",
        pieces: body.pieces || {},
        listCassette: body.listCassette || [],
        status: "waiting_change_removal",
        startedAtMs: Date.now(),
      };
      return json(res, 200, { ok: true, operation: activeOperation });
    }
    if (req.method === "POST" && path === "/api/change/removed") {
      activeOperation = null;
      deposit = deposit ? { ...deposit, status: "changed", changedAtMs: Date.now() } : null;
      return json(res, 200, { ok: true, changeRemoved: true });
    }
    if (req.method === "POST" && path === "/api/cashin/cancel") {
      activeOperation = null;
      deposit = deposit ? { ...deposit, status: "cancelled" } : null;
      return json(res, 200, { ok: true });
    }
    if (
      req.method === "POST" &&
      ["/api/machine/restart", "/api/machine/reboot", "/api/system/restart", "/api/restart"].includes(path)
    ) {
      await readBody(req);
      activeOperation = null;
      return json(res, 200, {
        ok: true,
        command: "restart",
        mode: "fake",
        restartedAtMs: Date.now(),
      });
    }
    if (
      req.method === "POST" &&
      ["/api/machine/reset", "/api/system/reset", "/api/reset"].includes(path)
    ) {
      await readBody(req);
      activeOperation = null;
      deposit = null;
      return json(res, 200, {
        ok: true,
        command: "reset",
        mode: "fake",
        resetAtMs: Date.now(),
      });
    }
    if (req.method === "GET" && path === "/api/machine/status-events") {
      return json(res, 200, { ok: true, events: [], state: snapshot() });
    }
    return json(res, 404, { ok: false, error: "Endpoint non trovato" });
  } catch (error) {
    return json(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[fake-automatic-cash-gateway] http://${HOST}:${PORT}`);
});
