import assert from "node:assert/strict";
import test from "node:test";

import {
  PEER_TRUST_DIRECTORY_MEDIA_TYPE_V1,
  createPeerTrustDirectoryRequestHandlerV1
} from "./peer-trust-transport-v1.mjs";

function capture() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = Buffer.from(body ?? []);
    }
  };
}

test("peer trust endpoint is absent while its independent flag is off", async () => {
  let reads = 0;
  const handler = createPeerTrustDirectoryRequestHandlerV1({
    enabled: false,
    readCurrentDirectory: async () => {
      reads += 1;
      return Buffer.from("secret");
    }
  });
  const output = capture();
  await handler(
    { method: "GET", url: "/v1/peer-trust-directory", socket: { encrypted: true } },
    output
  );
  assert.equal(output.status, 404);
  assert.equal(reads, 0);
});

test("peer trust endpoint requires TLS and exposes only bounded signed bytes", async () => {
  const body = Buffer.from('{"signed":true}');
  const handler = createPeerTrustDirectoryRequestHandlerV1({
    enabled: true,
    readCurrentDirectory: async () => body
  });
  const clear = capture();
  await handler(
    { method: "GET", url: "/v1/peer-trust-directory", socket: { encrypted: false } },
    clear
  );
  assert.equal(clear.status, 403);
  const output = capture();
  await handler(
    { method: "GET", url: "/v1/peer-trust-directory", socket: { encrypted: true } },
    output
  );
  assert.equal(output.status, 200);
  assert.equal(output.headers["cache-control"], "no-store");
  assert.equal(output.headers["content-type"], PEER_TRUST_DIRECTORY_MEDIA_TYPE_V1);
  assert.deepEqual(output.body, body);
});

test("endpoint is GET-only and fails closed when publication is unavailable", async () => {
  const handler = createPeerTrustDirectoryRequestHandlerV1({
    enabled: true,
    readCurrentDirectory: async () => {
      throw new Error("unavailable");
    }
  });
  const post = capture();
  await handler(
    { method: "POST", url: "/v1/peer-trust-directory", socket: { encrypted: true } },
    post
  );
  assert.equal(post.status, 405);
  const get = capture();
  await handler(
    { method: "GET", url: "/v1/peer-trust-directory", socket: { encrypted: true } },
    get
  );
  assert.equal(get.status, 503);
  assert.equal(get.headers["retry-after"], "1");
});
