import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

test("logout closes web audio and rejects an order response already in flight", async () => {
  const source = await readFile(
    new URL("../public/assets/postazione-order-sound.js", import.meta.url),
    "utf8"
  );
  const localStorage = new MemoryStorage({
    BAR_OPERATOR_AUTH_V1: JSON.stringify({
      token: "token-1",
      userId: "user-1",
      username: "mario",
    }),
    BAR_OPERATOR_SESSION_V1: JSON.stringify({
      loggedIn: true,
      userName: "Mario",
    }),
  });
  const sessionStorage = new MemoryStorage({
    "postazione:lastStation": "BAR-1",
  });
  const windowListeners = new Map();
  const documentListeners = new Map();
  const intervalCallbacks = [];
  let fetchCount = 0;
  let resolveDeferredFetch = null;
  let audioCloseCount = 0;
  let oscillatorStartCount = 0;

  const response = (orders) => ({
    ok: true,
    json: async () => ({ ok: true, orders }),
  });
  const fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) return response([{ id: "order-1" }]);
    return new Promise((resolve) => {
      resolveDeferredFetch = () => resolve(response([{ id: "order-1" }, { id: "order-2" }]));
    });
  };

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.state = "running";
    }

    createOscillator() {
      return {
        connect() {},
        frequency: { setValueAtTime() {} },
        start() {
          oscillatorStartCount += 1;
        },
        stop() {},
        type: "sine",
      };
    }

    createGain() {
      return {
        connect() {},
        gain: {
          exponentialRampToValueAtTime() {},
          setValueAtTime() {},
        },
      };
    }

    async resume() {
      this.state = "running";
    }

    async close() {
      this.state = "closed";
      audioCloseCount += 1;
    }
  }

  const addListener = (registry) => (type, listener) => {
    const listeners = registry.get(type) || [];
    listeners.push(listener);
    registry.set(type, listeners);
  };
  const dispatch = (registry, event) => {
    for (const listener of registry.get(event.type) || []) listener(event);
  };
  const window = {
    AudioContext: FakeAudioContext,
    addEventListener: addListener(windowListeners),
    dispatchEvent(event) {
      dispatch(windowListeners, event);
      return true;
    },
    localStorage,
    sessionStorage,
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    setTimeout,
    clearTimeout,
  };
  const document = {
    addEventListener: addListener(documentListeners),
    hidden: false,
    querySelector() {
      return null;
    },
    readyState: "complete",
  };

  vm.runInNewContext(source, {
    AbortController,
    Event,
    fetch,
    HTMLSelectElement: class {},
    Node: { TEXT_NODE: 3 },
    URLSearchParams,
    console,
    document,
    window,
  });

  await flushTasks();
  await flushTasks();
  assert.equal(fetchCount, 1);

  dispatch(documentListeners, { type: "pointerdown" });
  await flushTasks();
  intervalCallbacks[0]();
  await flushTasks();
  assert.equal(fetchCount, 2);
  assert.equal(typeof resolveDeferredFetch, "function");

  localStorage.removeItem("BAR_OPERATOR_AUTH_V1");
  localStorage.setItem(
    "BAR_OPERATOR_SESSION_V1",
    JSON.stringify({ loggedIn: false, userName: "Guest" })
  );
  window.dispatchEvent(new Event("postazione:session-cleared"));
  assert.equal(audioCloseCount, 1);

  resolveDeferredFetch();
  await flushTasks();
  await flushTasks();
  assert.equal(oscillatorStartCount, 0);

  intervalCallbacks[0]();
  await flushTasks();
  assert.equal(fetchCount, 2);
});
