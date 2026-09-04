import { EXTERNAL_FETCH_TIMEOUT_MS, parsePositiveInt } from "./config.js";

export async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = parsePositiveInt(options.timeoutMs, EXTERNAL_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
