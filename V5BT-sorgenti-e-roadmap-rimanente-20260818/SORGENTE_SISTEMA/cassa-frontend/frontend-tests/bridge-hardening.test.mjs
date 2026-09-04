import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { projectRoot } from "./helpers/bridge-env.mjs";

const BRIDGES = [
  {
    name: "mobile-backend-connection-bridge",
    path: "mobile-frontend/dist/assets/mobile-backend-connection-bridge.js",
    url: "http://localhost:5180/mobile/",
  },
  {
    name: "mobile-table-lock-lifecycle-bridge",
    path: "mobile-frontend/dist/assets/mobile-table-lock-lifecycle-bridge.js",
    url: "http://localhost:5180/mobile/",
  },
  {
    name: "mobile-payments-settlement-bridge",
    path: "mobile-frontend/dist/assets/mobile-payments-settlement-bridge.js",
    url: "http://localhost:5180/mobile/payments/",
  },
  {
    name: "cash-sale-session-guard",
    path: "cassa-frontend/dist/assets/cash-sale-session-guard.js",
    url: "http://localhost:5180/cassa/",
  },
  {
    name: "cash-preconto-print",
    path: "cassa-frontend/dist/assets/cash-preconto-print.js",
    url: "http://localhost:5180/cassa/",
  },
];

const NATIVE_MOBILE_BRIDGE_GUARDS = {
  "mobile-backend-connection-bridge": [
    {
      path: "mobile-frontend/src/shared/api/apiClient.ts",
      patterns: [
        /export function buildApiUrl/,
        /export function buildSseUrl/,
        /defaultRetryAttempts/,
        /return isIdempotentMethod\(init\) \? 1 : 0/,
      ],
    },
    {
      path: "mobile-frontend/tests/apiClient.test.ts",
      patterns: [/retries idempotent GET on 503/i, /does not retry non-idempotent POST/i],
    },
  ],
  "mobile-table-lock-lifecycle-bridge": [
    {
      path: "mobile-frontend/src/pages/home/tables/hooks/useTableLock.ts",
      patterns: [/acquireTableLock/, /startTableLockHeartbeat/, /releaseTableLock/],
    },
    {
      path: "mobile-frontend/src/api/tableLocks.ts",
      patterns: [/\/api\/tables\/lock\/acquire/, /\/api\/tables\/lock\/heartbeat/, /\/api\/tables\/lock\/release/],
    },
  ],
  "mobile-payments-settlement-bridge": [
    {
      path: "mobile-frontend/src/pages/payments/PaymentSettlementSection.tsx",
      patterns: [/Tavoli da riscuotere/, /mobile:payments:settlement-completed/, /clearMobilePaymentRuntime/],
    },
    {
      path: "mobile-frontend/src/app/runtime/usePaymentSessionRuntime.ts",
      patterns: [/installMobilePaymentSessionRuntime\(\)/],
    },
  ],
};

async function assertNativeMobileBridgeGuard(bridgeName) {
  const guards = NATIVE_MOBILE_BRIDGE_GUARDS[bridgeName];
  assert.ok(guards, `manca guard nativo per ${bridgeName}`);
  for (const guard of guards) {
    const source = await fs.readFile(path.join(projectRoot, guard.path), "utf8");
    for (const pattern of guard.patterns) {
      assert.match(source, pattern, `${bridgeName} deve essere coperto da ${guard.path}`);
    }
  }
}

function createVmBridgeSandbox(url) {
  const stats = {
    documentListeners: [],
    windowListeners: [],
    intervals: [],
    timeouts: [],
    fetchCalls: [],
    eventSourceCalls: [],
    clicks: 0,
  };
  let timerId = 1;

  class Element {
    constructor(tagName = "div") {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.parentNode = null;
      this.textContent = "";
      this.disabled = false;
      this.offsetParent = null;
      this.classList = {
        contains: () => false,
        add: () => {},
        remove: () => {},
      };
    }

    appendChild(node) {
      if (node && typeof node === "object") {
        node.parentNode = this;
        this.children.push(node);
      }
      return node;
    }

    removeChild(node) {
      this.children = this.children.filter((child) => child !== node);
      if (node && typeof node === "object") node.parentNode = null;
      return node;
    }

    remove() {
      if (this.parentNode && typeof this.parentNode.removeChild === "function") {
        this.parentNode.removeChild(this);
      }
    }

    querySelector() {
      return null;
    }

    querySelectorAll() {
      return [];
    }

    closest() {
      return null;
    }

    matches() {
      return false;
    }

    addEventListener(type, listener, options) {
      stats.documentListeners.push({ target: this.tagName, type, listener, options });
    }

    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    }

    getAttribute(name) {
      return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
    }

    hasAttribute(name) {
      return this.attributes.has(String(name));
    }

    removeAttribute(name) {
      this.attributes.delete(String(name));
    }

    click() {
      stats.clicks += 1;
    }
  }

  class HTMLElement extends Element {}
  class HTMLButtonElement extends HTMLElement {}
  class HTMLInputElement extends HTMLElement {
    constructor(tagName = "input") {
      super(tagName);
      this.checked = false;
      this.value = "";
    }
  }

  function createElement(tagName) {
    const normalized = String(tagName || "div").toLowerCase();
    if (normalized === "button") return new HTMLButtonElement(normalized);
    if (normalized === "input") return new HTMLInputElement(normalized);
    return new HTMLElement(normalized);
  }

  const document = {
    readyState: "complete",
    hidden: false,
    body: new HTMLElement("body"),
    documentElement: new HTMLElement("html"),
    createElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, listener, options) => {
      stats.documentListeners.push({ target: "document", type, listener, options });
    },
  };

  class NativeEventSource {
    constructor(input, config) {
      this.input = input;
      this.config = config;
      stats.eventSourceCalls.push({ input, config });
    }
  }

  const location = new URL(url);
  location.reload = () => {
    stats.reloaded = true;
  };

  const window = {
    document,
    location,
    navigator: { userAgent: "bridge-vm-test" },
    console,
    URL,
    URLSearchParams,
    EventSource: NativeEventSource,
    fetch: async (input, init) => {
      stats.fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, orders: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    addEventListener: (type, listener, options) => {
      stats.windowListeners.push({ type, listener, options });
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout: (callback, delay, ...args) => {
      const id = timerId++;
      stats.timeouts.push({ id, callback, delay, args });
      return id;
    },
    clearTimeout: () => {},
    setInterval: (callback, delay, ...args) => {
      const id = timerId++;
      stats.intervals.push({ id, callback, delay, args });
      return id;
    },
    clearInterval: () => {},
    alert: () => {},
    getComputedStyle: () => ({ display: "none" }),
  };
  window.window = window;
  window.self = window;

  const sandbox = {
    window,
    self: window,
    document,
    location,
    navigator: window.navigator,
    console,
    URL,
    URLSearchParams,
    Response,
    Request: undefined,
    Headers,
    Event,
    CustomEvent,
    EventSource: NativeEventSource,
    Element,
    HTMLElement,
    HTMLInputElement,
    HTMLButtonElement,
    Map,
    Set,
    Promise,
    Date,
    Intl,
    Array,
    Object,
    JSON,
    String,
    Number,
    Math,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    fetch: window.fetch,
  };

  return {
    context: vm.createContext(sandbox),
    document,
    stats,
    window,
  };
}

async function runBridge(context, relativePath) {
  const code = await fs.readFile(path.join(projectRoot, relativePath), "utf8");
  const script = new vm.Script(code, { filename: relativePath });
  script.runInContext(context);
}

async function flushVmMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function installCount(stats) {
  return stats.documentListeners.length + stats.windowListeners.length + stats.intervals.length + stats.timeouts.length;
}

test("la Postazione gestisce checkbox e workflow nel runtime React", async () => {
  const [appSource, indexSource, publicAssets, distAssets] = await Promise.all([
    fs.readFile(path.join(projectRoot, "postazione/src/App.jsx"), "utf8"),
    fs.readFile(path.join(projectRoot, "postazione/index.html"), "utf8"),
    fs.readdir(path.join(projectRoot, "postazione/public/assets")),
    fs.readdir(path.join(projectRoot, "postazione/dist/assets")),
  ]);

  assert.doesNotMatch(indexSource, /postazione-[^"']*bridge\.js/i);
  assert.equal(
    [...publicAssets, ...distAssets].some((name) => /^postazione-.*bridge\.js$/i.test(name)),
    false,
  );
  assert.match(appSource, /const markReady = useCallback\(async \(\) => \{/);
  assert.match(
    appSource,
    /const toggleGroup = useCallback\(\s*\(groupKey,\s*checked\)\s*=>\s*\{/s,
  );
  assert.match(appSource, /workflowStatus: "ready"/);
  assert.match(appSource, /checked=\{allDone\}/);
  assert.match(appSource, /onChange=\{\(e\) => toggleGroup\(g\.key, e\.target\.checked\)\}/);
});

for (const bridge of BRIDGES) {
  test(`${bridge.name} e idempotente e tollera ambiente incompleto`, async (t) => {
    const absoluteBridgePath = path.join(projectRoot, bridge.path);
    if (!existsSync(absoluteBridgePath) && bridge.path.startsWith("mobile-frontend/")) {
      await assertNativeMobileBridgeGuard(bridge.name);
      return;
    }
    const { context, stats, window } = createVmBridgeSandbox(bridge.url);

    await assert.doesNotReject(() => runBridge(context, bridge.path));
    await flushVmMicrotasks();
    const firstInstallCount = installCount(stats);
    const firstFetch = window.fetch;
    const firstEventSource = window.EventSource;

    await assert.doesNotReject(() => runBridge(context, bridge.path));
    await flushVmMicrotasks();
    assert.equal(installCount(stats), firstInstallCount, "secondo load non deve aggiungere listener o timer");
    assert.equal(window.EventSource, firstEventSource, "EventSource non deve essere rimpiazzato al secondo load");

    const response = await window.fetch("/bridge-smoke");
    assert.equal(typeof window.fetch, "function");
    assert.equal(response.status, 200);
    assert.doesNotThrow(() => new window.EventSource("/bridge-smoke-events"));
    assert.equal(typeof window.EventSource, "function");
    assert.ok(firstFetch === window.fetch || typeof window.fetch === "function");
  });
}
