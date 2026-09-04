import fs from "node:fs";
import path from "node:path";

const rootArgIndex = process.argv.indexOf("--root");
const root = path.resolve(rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : ".");
const vectors = JSON.parse(
  fs.readFileSync(path.join(root, "contracts/PROTOCOL_TEST_VECTORS.json"), "utf8")
);
const aliasPattern = /^[0-9a-f]{12}$/i;

const results = vectors.dialerElection.map((vector) => {
  if (!aliasPattern.test(vector.localAlias) || !aliasPattern.test(vector.remoteAlias)) {
    throw new Error("dialer election aliases must be 48-bit hexadecimal values");
  }
  if (vector.localAlias.toLowerCase() === vector.remoteAlias.toLowerCase()) {
    throw new Error("dialer election vector must not use colliding aliases");
  }

  return {
    ...vector,
    actualRole:
      vector.localAlias.toLowerCase() < vector.remoteAlias.toLowerCase()
        ? "GATT_SERVER"
        : "GATT_CLIENT"
  };
});
const ok = results.every((result) => result.actualRole === result.expectedRole);
console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) {
  process.exit(1);
}
