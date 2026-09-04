export const PEER_TRUST_DIRECTORY_PATH_V1 = "/v1/peer-trust-directory";
export const PEER_TRUST_DIRECTORY_MEDIA_TYPE_V1 =
  "application/vnd.cassav5bt.peer-trust-directory-v1+json";
export const PEER_TRUST_DIRECTORY_MAX_RESPONSE_BYTES_V1 = 262_144;

function response(response, status, body = Buffer.alloc(0), headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": body.byteLength,
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(body);
}

export function createPeerTrustDirectoryRequestHandlerV1({
  enabled = false,
  readCurrentDirectory
}) {
  if (typeof readCurrentDirectory !== "function") {
    throw new TypeError("readCurrentDirectory must be a function");
  }
  return async (request, output) => {
    if (!enabled) {
      response(output, 404);
      return;
    }
    if (request.url !== PEER_TRUST_DIRECTORY_PATH_V1) {
      response(output, 404);
      return;
    }
    if (request.method !== "GET") {
      response(output, 405, Buffer.alloc(0), { allow: "GET" });
      return;
    }
    if (request.socket?.encrypted !== true) {
      response(output, 403);
      return;
    }
    let wire;
    try {
      wire = Buffer.from(await readCurrentDirectory());
      if (
        wire.byteLength < 1 ||
        wire.byteLength > PEER_TRUST_DIRECTORY_MAX_RESPONSE_BYTES_V1
      ) {
        throw new Error("signed directory size is invalid");
      }
    } catch {
      wire?.fill(0);
      response(output, 503, Buffer.alloc(0), { "retry-after": "1" });
      return;
    }
    try {
      response(output, 200, wire, {
        "content-type": PEER_TRUST_DIRECTORY_MEDIA_TYPE_V1
      });
    } finally {
      wire.fill(0);
    }
  };
}

