import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const helperDir = path.dirname(fileURLToPath(import.meta.url));
export const cassaRoot = path.resolve(helperDir, "..", "..");
export const projectRoot = path.resolve(cassaRoot, "..");

export async function readAsset(relativePath) {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

export function createBridgeDom(html = "<!doctype html><html><body></body></html>", options = {}) {
  const dom = new JSDOM(html, {
    url: options.url ?? "http://localhost:5180/mobile/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  if (typeof globalThis.Request === "function") dom.window.Request = globalThis.Request;
  if (typeof globalThis.Headers === "function") dom.window.Headers = globalThis.Headers;
  if (typeof globalThis.Response === "function") dom.window.Response = globalThis.Response;
  return dom;
}

export async function evalAsset(dom, relativePath) {
  const code = await readAsset(relativePath);
  dom.window.eval(code);
}

export function flushBridgeTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function installFetchMock(window, handler) {
  const calls = [];
  window.fetch = async (input, init) => {
    calls.push({ input, init });
    return handler(input, init, calls);
  };
  return calls;
}

export function installTimerMocks(window) {
  let nextId = 1;
  const intervals = [];
  const timeouts = [];
  window.setInterval = (callback, delay, ...args) => {
    const id = nextId;
    nextId += 1;
    intervals.push({ id, callback, delay, args, cleared: false });
    return id;
  };
  window.clearInterval = (id) => {
    const record = intervals.find((entry) => entry.id === id);
    if (record) record.cleared = true;
  };
  window.setTimeout = (callback, delay, ...args) => {
    const id = nextId;
    nextId += 1;
    timeouts.push({ id, callback, delay, args, cleared: false });
    return id;
  };
  window.clearTimeout = (id) => {
    const record = timeouts.find((entry) => entry.id === id);
    if (record) record.cleared = true;
  };
  window.requestAnimationFrame = (callback) => {
    const id = nextId;
    nextId += 1;
    timeouts.push({ id, callback: () => callback(Date.now()), delay: 16, args: [], cleared: false });
    return id;
  };
  return { intervals, timeouts };
}
