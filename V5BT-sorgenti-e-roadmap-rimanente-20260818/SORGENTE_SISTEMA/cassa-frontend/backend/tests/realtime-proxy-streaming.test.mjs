import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const proxySource = fs.readFileSync(path.resolve(here, "../../../serve-frontends.mjs"), "utf8");

test("il proxy tratta gli endpoint SSE come stream non bufferizzati", () => {
  assert.match(proxySource, /function isRealtimeEventStreamPath\(/);
  assert.match(proxySource, /text\/event-stream/);
  assert.match(proxySource, /X-Accel-Buffering["']?:\s*["']no["']/);
  assert.match(proxySource, /res\.flushHeaders\?\.\(\)/);
  assert.match(proxySource, /res\.flush\?\.\(\)/);
  assert.match(proxySource, /upstreamRes\.socket\?\.setNoDelay\?\.\(true\)/);
  assert.match(proxySource, /upstream\.setTimeout\(0\)/);
});
