#!/usr/bin/env node
import {
  initializePeerTrustAuthorityFilesV1
} from "../dist/security/PeerTrustAuthorityKeyFileV1.js";

function usage() {
  process.stderr.write(
    "Usage: peer-trust-authority.mjs init --private-key PATH " +
      "--public-spki PATH --public-pin PATH\n"
  );
}

function options(argv) {
  if (argv[0] !== "init") throw new Error("only the init command is supported");
  const result = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("authority init arguments are invalid");
    }
    if (result.has(name)) throw new Error(`duplicate option ${name}`);
    result.set(name, value);
  }
  const expected = ["--private-key", "--public-spki", "--public-pin"];
  if (
    result.size !== expected.length ||
    expected.some((name) => !result.has(name))
  ) throw new Error("authority init requires all three output paths");
  return {
    privateKeyPath: result.get("--private-key"),
    publicSpkiPath: result.get("--public-spki"),
    publicPinPath: result.get("--public-pin")
  };
}

try {
  const result = await initializePeerTrustAuthorityFilesV1(options(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "cassav6.bluetooth.peer-trust-authority-public",
    ...result
  })}\n`);
} catch (error) {
  usage();
  process.stderr.write(`${error instanceof Error ? error.message : "authority init failed"}\n`);
  process.exitCode = 1;
}
