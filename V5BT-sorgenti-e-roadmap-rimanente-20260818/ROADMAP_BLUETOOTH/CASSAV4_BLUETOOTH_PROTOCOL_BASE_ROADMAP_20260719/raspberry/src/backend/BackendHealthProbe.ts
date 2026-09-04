export const BACKEND_HEALTH_FAILURES = Object.freeze({
  NONE: "NONE",
  TIMEOUT: "TIMEOUT",
  NETWORK: "NETWORK",
  HTTP_STATUS: "HTTP_STATUS",
  CONTENT_TYPE: "CONTENT_TYPE",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  INVALID_BODY: "INVALID_BODY"
} as const);

export type BackendHealthFailure =
  (typeof BACKEND_HEALTH_FAILURES)[keyof typeof BACKEND_HEALTH_FAILURES];

export interface BackendHealthResult {
  readonly canReachServer: boolean;
  readonly rttMs: number | null;
  readonly failure: BackendHealthFailure;
  readonly sampledAtEpochMs: number;
}

interface HealthHeaders {
  get(name: string): string | null;
}

interface HealthResponse {
  readonly status: number;
  readonly redirected: boolean;
  readonly headers: HealthHeaders;
  readonly body: HealthReadableBody | null;
}

interface HealthReadableBody {
  getReader(): HealthBodyReader;
}

interface HealthBodyReader {
  read(): Promise<Readonly<{
    done: boolean;
    value?: Uint8Array;
  }>>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface BackendHealthFetchPort {
  (
    url: string,
    init: Readonly<{
      method: "GET";
      redirect: "error";
      cache: "no-store";
      signal: AbortSignal;
      headers: Readonly<Record<string, string>>;
    }>
  ): Promise<HealthResponse>;
}

export class BackendHealthProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BackendHealthProbeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new BackendHealthProbeError(code, message);
}

function canonicalLocalHealthUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_HEALTH_URL", "backend health URL is invalid");
  }
  const localHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !localHosts.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.pathname === "/" ||
    url.pathname.endsWith("/")
  ) {
    fail(
      "INVALID_HEALTH_URL",
      "health URL must be a credential-free loopback endpoint with a canonical path"
    );
  }
  return url.toString();
}

export class BackendHealthProbe {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: BackendHealthFetchPort;
  readonly #monotonicNow: () => number;
  readonly #epochNow: () => number;
  #attempts = 0;
  #successes = 0;
  #failures = 0;
  #lastResult: BackendHealthResult | null = null;
  #lastMonotonicMs = 0;

  constructor(input: {
    readonly url: string;
    readonly timeoutMs?: number;
    readonly fetch?: BackendHealthFetchPort;
    readonly monotonicNow?: () => number;
    readonly epochNow?: () => number;
  }) {
    this.#url = canonicalLocalHealthUrl(input.url);
    this.#timeoutMs = input.timeoutMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 100 ||
      this.#timeoutMs > 5_000
    ) {
      fail("INVALID_TIMEOUT", "health timeout must be from 100 to 5000 ms");
    }
    this.#fetch =
      input.fetch ??
      (globalThis.fetch as unknown as BackendHealthFetchPort);
    this.#monotonicNow = input.monotonicNow ?? (() => performance.now());
    this.#epochNow = input.epochNow ?? Date.now;
  }

  async probe(): Promise<Readonly<BackendHealthResult>> {
    const startedMonotonic = this.#checkedMonotonic();
    const sampledAtEpochMs = this.#epochNow();
    if (
      !Number.isSafeInteger(sampledAtEpochMs) ||
      sampledAtEpochMs < 0
    ) {
      fail("INVALID_CLOCK", "epoch clock is outside its canonical range");
    }
    this.#attempts += 1;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.#timeoutMs);
    let result: BackendHealthResult;
    try {
      const response = await this.#fetch(this.#url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: abort.signal,
        headers: Object.freeze({
          accept: "application/json",
          "x-v5bt-purpose": "bluetooth-route-health"
        })
      });
      const finishedMonotonic = this.#checkedMonotonic();
      const rttMs = Math.max(0, finishedMonotonic - startedMonotonic);
      if (
        response.redirected ||
        response.status < 200 ||
        response.status > 299
      ) {
        result = {
          canReachServer: false,
          rttMs: null,
          failure: BACKEND_HEALTH_FAILURES.HTTP_STATUS,
          sampledAtEpochMs
        };
      } else if (
        (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      ) {
        result = {
          canReachServer: false,
          rttMs: null,
          failure: BACKEND_HEALTH_FAILURES.CONTENT_TYPE,
          sampledAtEpochMs
        };
      } else {
        const contentLength = response.headers.get("content-length");
        const declaredLength =
          contentLength !== null && /^[0-9]+$/.test(contentLength)
            ? Number(contentLength)
            : null;
        if (
          declaredLength !== null &&
          Number.isSafeInteger(declaredLength) &&
          declaredLength > MAXIMUM_HEALTH_RESPONSE_BYTES
        ) {
          result = {
            canReachServer: false,
            rttMs: null,
            failure: BACKEND_HEALTH_FAILURES.RESPONSE_TOO_LARGE,
            sampledAtEpochMs
          };
        } else {
          const body = await readBoundedBody(response.body);
          if (body === null) {
            result = {
              canReachServer: false,
              rttMs: null,
              failure: BACKEND_HEALTH_FAILURES.RESPONSE_TOO_LARGE,
              sampledAtEpochMs
            };
          } else {
            let value: unknown;
            try {
              value = JSON.parse(body);
            } catch {
              value = null;
            }
            const record = value as Record<string, unknown> | null;
            result =
              record !== null &&
              !Array.isArray(record) &&
              record.ok === true
                ? {
                    canReachServer: true,
                    rttMs,
                    failure: BACKEND_HEALTH_FAILURES.NONE,
                    sampledAtEpochMs
                  }
                : {
                    canReachServer: false,
                    rttMs: null,
                    failure: BACKEND_HEALTH_FAILURES.INVALID_BODY,
                    sampledAtEpochMs
                  };
          }
        }
      }
    } catch (error) {
      if (
        error instanceof BackendHealthProbeError &&
        error.code === "CLOCK_REGRESSION"
      ) {
        throw error;
      }
      result = {
        canReachServer: false,
        rttMs: null,
        failure:
          abort.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? BACKEND_HEALTH_FAILURES.TIMEOUT
            : BACKEND_HEALTH_FAILURES.NETWORK,
        sampledAtEpochMs
      };
    } finally {
      clearTimeout(timeout);
    }
    if (result.canReachServer) this.#successes += 1;
    else this.#failures += 1;
    this.#lastResult = Object.freeze(result);
    return this.#lastResult;
  }

  snapshot(): Readonly<{
    attempts: number;
    successes: number;
    failures: number;
    reachable: boolean;
    lastFailure: BackendHealthFailure | null;
  }> {
    return Object.freeze({
      attempts: this.#attempts,
      successes: this.#successes,
      failures: this.#failures,
      reachable: this.#lastResult?.canReachServer ?? false,
      lastFailure: this.#lastResult?.failure ?? null
    });
  }

  #checkedMonotonic(): number {
    const value = this.#monotonicNow();
    if (!Number.isFinite(value) || value < this.#lastMonotonicMs) {
      fail("CLOCK_REGRESSION", "health probe monotonic clock moved backwards");
    }
    this.#lastMonotonicMs = value;
    return value;
  }
}

const MAXIMUM_HEALTH_RESPONSE_BYTES = 4_096;

async function readBoundedBody(
  body: HealthReadableBody | null
): Promise<string | null> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
        throw new BackendHealthProbeError(
          "INVALID_BODY_STREAM",
          "health response body stream is invalid"
        );
      }
      total += result.value.byteLength;
      if (total > MAXIMUM_HEALTH_RESPONSE_BYTES) {
        await reader.cancel?.("health response exceeds bounded body limit");
        return null;
      }
      chunks.push(Buffer.from(result.value));
    }
    const value = Buffer.concat(chunks, total);
    try {
      return value.toString("utf8");
    } finally {
      value.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock?.();
  }
}
