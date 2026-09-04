import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializePeerTrustAuthorityFilesV1,
  loadPeerTrustAuthoritySignerFromFileV1
} from
  "../dist/security/PeerTrustAuthorityKeyFileV1.js";

test("authority signing key is accepted only from an owned regular 0600 P256 file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v6-peer-authority-"));
  const keyPath = path.join(root, "authority.pem");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(
    keyPath,
    pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 }
  );
  const signer = await loadPeerTrustAuthoritySignerFromFileV1(keyPath);
  assert.match(signer.toString(), /privateKey=<redacted>/);
  await chmod(keyPath, 0o640);
  await assert.rejects(
    loadPeerTrustAuthoritySignerFromFileV1(keyPath),
    /single-link 0600/
  );
  await chmod(keyPath, 0o600);
  const linkPath = path.join(root, "authority-link.pem");
  await symlink(keyPath, linkPath);
  await assert.rejects(loadPeerTrustAuthoritySignerFromFileV1(linkPath));
});

test("authority init creates only exclusive owned single-link 0600 outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v6-peer-authority-init-"));
  const privateKeyPath = path.join(root, "authority.pem");
  const publicSpkiPath = path.join(root, "authority.spki");
  const publicPinPath = path.join(root, "authority.pin");
  const result = await initializePeerTrustAuthorityFilesV1({
    privateKeyPath,
    publicSpkiPath,
    publicPinPath
  });
  assert.match(result.publicKeySpkiBase64, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(result.publicKeyPin, /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.match(result.authorityKeyId, /^[0-9a-f]{64}$/);
  for (const output of [privateKeyPath, publicSpkiPath, publicPinPath]) {
    const stat = await lstat(output);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid());
  }
  assert.equal(
    (await readFile(publicSpkiPath, "ascii")).trim(),
    result.publicKeySpkiBase64
  );
  assert.equal(
    (await readFile(publicPinPath, "ascii")).trim(),
    result.publicKeyPin
  );
  assert.doesNotMatch(await readFile(publicSpkiPath, "ascii"), /PRIVATE KEY/);
  assert.doesNotMatch(await readFile(publicPinPath, "ascii"), /PRIVATE KEY/);

  await assert.rejects(
    initializePeerTrustAuthorityFilesV1({
      privateKeyPath,
      publicSpkiPath: path.join(root, "second.spki"),
      publicPinPath: path.join(root, "second.pin")
    }),
    /exist/i
  );
});

test("authority init refuses symlink and hardlink targets without overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v6-peer-authority-links-"));
  const sentinel = path.join(root, "sentinel");
  await writeFile(sentinel, "unchanged", { mode: 0o600 });
  const symlinkPath = path.join(root, "authority-symlink.pem");
  await symlink(sentinel, symlinkPath);
  await assert.rejects(
    initializePeerTrustAuthorityFilesV1({
      privateKeyPath: symlinkPath,
      publicSpkiPath: path.join(root, "symlink.spki"),
      publicPinPath: path.join(root, "symlink.pin")
    })
  );
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");

  const hardlinkPath = path.join(root, "authority-hardlink.pem");
  await link(sentinel, hardlinkPath);
  await assert.rejects(
    initializePeerTrustAuthorityFilesV1({
      privateKeyPath: hardlinkPath,
      publicSpkiPath: path.join(root, "hardlink.spki"),
      publicPinPath: path.join(root, "hardlink.pin")
    })
  );
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  assert.equal((await lstat(sentinel)).nlink, 2);
});
