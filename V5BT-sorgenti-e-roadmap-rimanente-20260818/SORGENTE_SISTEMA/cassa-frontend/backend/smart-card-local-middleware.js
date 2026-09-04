import readline from "node:readline";

const SMART_CARD_BACKEND_URL = String(process.env.SMART_CARD_BACKEND_URL ?? "http://localhost:5281")
  .trim()
  .replace(/\/+$/, "");
const SMART_CARD_PUSH_PATH_RAW = String(process.env.SMART_CARD_PUSH_PATH ?? "/api/smart/card/detected").trim();
const SMART_CARD_PUSH_PATH = SMART_CARD_PUSH_PATH_RAW.startsWith("/")
  ? SMART_CARD_PUSH_PATH_RAW
  : `/${SMART_CARD_PUSH_PATH_RAW}`;
const SMART_CARD_PUSH_TOKEN = String(process.env.SMART_CARD_PUSH_TOKEN ?? "").trim();
const SMART_CARD_PUSH_TIMEOUT_MS = Number.parseInt(String(process.env.SMART_CARD_PUSH_TIMEOUT_MS ?? "5000"), 10);
const REQUEST_TIMEOUT_MS = Number.isFinite(SMART_CARD_PUSH_TIMEOUT_MS) && SMART_CARD_PUSH_TIMEOUT_MS > 0
  ? SMART_CARD_PUSH_TIMEOUT_MS
  : 5000;
const SMART_CARD_PUSH_URL = `${SMART_CARD_BACKEND_URL}${SMART_CARD_PUSH_PATH}`;

function normalizeChipCode(rawValue) {
  return String(rawValue ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim();
}

async function parsePayload(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function pushChipCode(chipCode) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId =
    controller !== null
      ? setTimeout(() => {
          controller.abort();
        }, REQUEST_TIMEOUT_MS)
      : null;

  try {
    const headers = {
      "Content-Type": "application/json",
    };
    if (SMART_CARD_PUSH_TOKEN) {
      headers["x-smart-card-token"] = SMART_CARD_PUSH_TOKEN;
    }

    const response = await fetch(SMART_CARD_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ chipCode }),
      signal: controller?.signal,
    });
    const payload = await parsePayload(response);

    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (!payload || typeof payload !== "object" || payload.ok !== true) {
      throw new Error("Risposta backend non valida.");
    }

    return payload;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Errore di comunicazione con il backend.");
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

let sendQueue = Promise.resolve();
let shuttingDown = false;

function enqueueChipCode(chipCode) {
  sendQueue = sendQueue
    .then(async () => {
      const payload = await pushChipCode(chipCode);
      const detectedAt = typeof payload.detectedAt === "string" ? payload.detectedAt : new Date().toISOString();
      console.log(`[middleware] inviato: ${chipCode} (${detectedAt})`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Errore invio.";
      console.error(`[middleware] errore invio backend: ${message}`);
    });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();
  try {
    await sendQueue;
  } finally {
    console.log("\nUscita.");
    process.exit(0);
  }
}

console.log("Metti il cursore qui, poi passa il badge.");
console.log("Se il lettore invia anche INVIO, il codice viene inviato subito al backend.");
console.log(`Backend target: ${SMART_CARD_PUSH_URL}`);
if (SMART_CARD_PUSH_TOKEN) {
  console.log("Auth token middleware: attivo");
} else {
  console.log("Auth token middleware: non impostato (backend accetta solo localhost)");
}
console.log("Ctrl+C per uscire.\n");

rl.setPrompt("Codice letto: ");
rl.prompt();

rl.on("line", (line) => {
  const chipCode = normalizeChipCode(line);
  if (chipCode) {
    console.log(`-> ${chipCode}`);
    enqueueChipCode(chipCode);
  }
  rl.prompt();
});

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
