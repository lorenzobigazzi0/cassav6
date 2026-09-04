import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBearerToken,
  hashOpaqueToken,
  isLoopbackAddress,
  isPrivateNetworkAddress,
  normalizeIpAddress,
  readHeaderValue,
  safeTokenEquals,
} from "../core/security.js";

test("core security helpers normalizzano header, bearer token e IP", () => {
  assert.equal(readHeaderValue({ headers: { authorization: "  Bearer token-123  " } }, "Authorization"), "Bearer token-123");
  assert.equal(extractBearerToken("Bearer token-123"), "token-123");
  assert.equal(extractBearerToken("Basic abc"), "");
  assert.equal(normalizeIpAddress("::ffff:192.168.1.10"), "192.168.1.10");
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("172.16.2.3"), true);
  assert.equal(isPrivateNetworkAddress("172.32.2.3"), false);
});

test("safeTokenEquals usa confronto semantico costante e rifiuta valori vuoti", () => {
  assert.equal(safeTokenEquals("secret", "secret"), true);
  assert.equal(safeTokenEquals(" secret ", "secret"), true);
  assert.equal(safeTokenEquals("secret", "different-length-secret"), false);
  assert.equal(safeTokenEquals("", "secret"), false);
  assert.equal(safeTokenEquals("secret", ""), false);
});

test("hashOpaqueToken restituisce digest HMAC stabile solo con token e secret", () => {
  const first = hashOpaqueToken("token", "secret");
  const second = hashOpaqueToken("token", "secret");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(hashOpaqueToken("token", ""), "");
  assert.equal(hashOpaqueToken("", "secret"), "");
});
