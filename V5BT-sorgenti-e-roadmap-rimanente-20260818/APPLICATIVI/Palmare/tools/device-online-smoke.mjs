import { writeFile } from "node:fs/promises";

const port = Number(process.argv[2] || 9225);
const username = process.env.PALMARE_TEST_USER || "";
const pin = process.env.PALMARE_TEST_PIN || "";
const screenshotPath = process.env.PALMARE_SCREENSHOT_PATH || "";
const navigationTarget = process.env.PALMARE_NAVIGATE || "";
if (!username || !pin) throw new Error("Impostare PALMARE_TEST_USER e PALMARE_TEST_PIN.");

const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = Array.isArray(pages) ? pages[0] : null;
if (!page?.webSocketDebuggerUrl) throw new Error(`Nessuna WebView sulla porta ${port}.`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await request("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};

const initial = await evaluate(`({
  href: location.href,
  secureContext: isSecureContext,
  inputs: [...document.querySelectorAll('input')].map((input) => ({
    placeholder: input.placeholder,
    type: input.type
  })),
  buttons: [...document.querySelectorAll('button')].map((button) => button.textContent?.trim()).filter(Boolean)
})`);

if (String(initial.href).includes("/login")) {
  const loginResult = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const usernameInput = inputs.find((input) => /username/i.test(input.placeholder || input.name || ''));
    const pinInput = inputs.find((input) => /pin/i.test(input.placeholder || input.name || '') || input.type === 'password');
    const submit = [...document.querySelectorAll('button')].find((button) => /entra|accedi/i.test(button.textContent || ''));
    if (!usernameInput || !pinInput || !submit) return { ok: false, reason: 'login-controls-missing' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(usernameInput, ${JSON.stringify(username)});
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(pinInput, ${JSON.stringify(pin)});
    pinInput.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    return { ok: true };
  })()`);
  if (!loginResult?.ok) throw new Error(`Login non avviato: ${loginResult?.reason || "unknown"}`);
}

let authenticated = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = await evaluate(`({
    href: location.href,
    hasHome: Boolean(document.querySelector('.home-shell, .home-card, .mobile-dashboard')),
    error: document.querySelector('[role="alert"], .login-error')?.textContent?.trim() || ''
  })`);
  if (!String(state.href).includes("/login") || state.hasHome) {
    authenticated = true;
    break;
  }
  if (state.error) throw new Error(`Login rifiutato: ${state.error}`);
}
if (!authenticated) throw new Error("Timeout durante il login Palmare.");

const result = await evaluate(`(async () => {
  const healthResponse = await fetch('/api/health', { cache: 'no-store' });
  const health = await healthResponse.json();
  const outbox = await new Promise((resolve) => {
    const open = indexedDB.open('palmare-offline-v1', 1);
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const request = open.result.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    };
  });
  return {
    href: location.href,
    secureContext: isSecureContext,
    health,
    identity: {
      username: localStorage.getItem('pos_user') || '',
      fullName: localStorage.getItem('pos_full_name') || '',
      roomName: localStorage.getItem('pos_room_name') || ''
    },
    visibleHeadings: [...document.querySelectorAll('h1,h2,h3')]
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
      .slice(0, 12),
    navigation: [...document.querySelectorAll('button,a')]
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
      .slice(0, 30),
    controls: [...document.querySelectorAll('button,a')]
      .map((node) => ({
        text: node.textContent?.trim() || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        title: node.getAttribute('title') || '',
        className: node.className || ''
      }))
      .filter((item) => item.text || item.ariaLabel || item.title)
      .slice(0, 50),
    outbox: outbox.map((entry) => ({
      requestId: entry.requestId,
      status: entry.status,
      replayMode: entry.replayMode,
      url: entry.url
    }))
  };
})()`);

let navigationResult = null;
if (navigationTarget) {
  const clicked = await evaluate(`(() => {
    const target = ${JSON.stringify(navigationTarget)};
    const control = [...document.querySelectorAll('button,a')]
      .find((node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent]
        .some((value) => (value || '').trim() === target));
    if (!control) return false;
    control.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Controllo di navigazione non trovato: ${navigationTarget}`);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  navigationResult = await evaluate(`({
    href: location.href,
    title: document.querySelector('.topbar-title, .menu-stage-title')?.textContent?.trim() || '',
    tables: document.querySelectorAll('.table-card, .mobile-table-card, [data-table-id]').length,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    errors: [...document.querySelectorAll('[role="alert"], .error, .is-error')]
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
      .slice(0, 10),
    controls: [...document.querySelectorAll('button')]
      .map((node) => node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent?.trim())
      .filter(Boolean)
      .slice(0, 30)
  })`);
}

if (screenshotPath) {
  const screenshot = await request("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

socket.close();
console.log(JSON.stringify({ initial, result, navigationResult }, null, 2));
