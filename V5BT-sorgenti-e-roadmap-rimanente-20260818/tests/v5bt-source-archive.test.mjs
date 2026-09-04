import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "tools", "create-v5bt-source-archive.sh");

function sourceList() {
  const result = spawnSync(script, ["--list-only"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return result.stdout.trimEnd().split("\n");
}

const forbiddenDirectories = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".print-spool",
  ".runtime",
  ".cache",
  ".credentials",
  ".dart_tool",
  ".expo",
  ".keys",
  ".logs",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".private",
  ".pytest_cache",
  ".registry",
  ".secrets",
  ".svelte-kit",
  ".turbo",
  ".v5bt-private",
  ".vite",
  "__pycache__",
  "artifacts",
  "build",
  "cache",
  "caches",
  "cert",
  "certificates",
  "certs",
  "coverage",
  "dist",
  "keys",
  "keystore",
  "log",
  "logs",
  "node_modules",
  "out",
  "p4-results",
  "private",
  "registry",
  "snapshots",
  "target",
  "temp",
  "tmp",
]);

const forbiddenSuffix = /(?:\.last\.json|\.(?:ledger|private|registry|runtime)\.json|\.private\.jsonl|\.(?:aab|aar|age|apk|asc|bz2|cab|class|crt|cer|csr|db|deb|der|dex|dll|dmg|dylib|ear|exe|gpg|img|ipa|iso|jks|kdb|kdbx|key|keystore|log|lz|lzma|mobileprovision|o|obj|ovpn|p12|pem|pfx|pgp|ppk|private-key|provisionprofile|pub|pyc|pyo|rar|rpm|secret|shm|so|sqlite|sqlite3|tar|tbz|tbz2|tgz|tsbuildinfo|txz|wal|war|wasm|xz|zip|zst|7z))$/i;

test("l'allowlist dell'archivio contiene solo sorgenti portabili", () => {
  const files = sourceList();
  assert.ok(files.length > 100, "inventario sorgente insolitamente vuoto");
  assert.deepEqual(files, [...new Set(files)].sort(), "inventario non ordinato o duplicato");

  for (const relative of files) {
    assert.ok(relative.length > 0);
    assert.equal(path.posix.isAbsolute(relative), false, relative);
    assert.doesNotMatch(relative, /[\t\r\n]/);

    const lower = relative.toLowerCase();
    const segments = lower.split("/");
    assert.equal(segments.includes(".."), false, relative);
    for (const segment of segments.slice(0, -1)) {
      assert.equal(forbiddenDirectories.has(segment), false, relative);
    }

    assert.doesNotMatch(
      lower,
      /^applicativi\/(?:palmare|postazione)\/android-app\/app\/src\/main\/assets\/(?:mobile|postazione)\//,
      relative,
    );
    assert.doesNotMatch(lower, /\.(?:apk|aab)(?:\.sha256)?$/, relative);
    assert.doesNotMatch(lower, /(?:apk|aab).*sha256sums/, relative);

    if (lower.endsWith(".jar")) {
      assert.match(lower, /\/gradle\/wrapper\/gradle-wrapper\.jar$/, relative);
    } else if (lower.endsWith(".gz")) {
      assert.match(lower, /^database\/.*\.sql\.gz$/, relative);
    } else if (lower.endsWith(".sqlite")) {
      assert.equal(
        new Set([
          "baseline_server_raspberry/database/sqlite/backend-relational.sqlite",
          "baseline_server_raspberry/database/sqlite/app-state-split.sqlite",
        ]).has(lower),
        true,
        relative,
      );
    } else {
      assert.doesNotMatch(lower, forbiddenSuffix, relative);
    }

    const basename = path.posix.basename(lower);
    if (basename === ".env" || basename.startsWith(".env.")) {
      assert.equal(basename.endsWith(".env.example"), true, relative);
    }
  }
});

test("lockfile, wrapper Gradle, sorgenti e dump SQL compressi restano inclusi", () => {
  const files = new Set(sourceList());
  for (const required of [
    "APPLICATIVI/Palmare/android-app/app/src/main/AndroidManifest.xml",
    "APPLICATIVI/Palmare/android-app/gradle/wrapper/gradle-wrapper.jar",
    "APPLICATIVI/Palmare/web-frontend/package-lock.json",
    "APPLICATIVI/Palmare/web-frontend/src/main.tsx",
    "APPLICATIVI/Postazione/android-app/app/src/main/AndroidManifest.xml",
    "APPLICATIVI/Postazione/android-app/gradle/wrapper/gradle-wrapper.jar",
    "APPLICATIVI/Postazione/web-frontend/package-lock.json",
    "APPLICATIVI/Postazione/web-frontend/src/main.jsx",
    "database/cassa_local_v46_snapshot_20260719.sql.gz",
    "database/cassav5bt_production_seed_20260719.sql.gz",
    "BASELINE_SERVER_RASPBERRY/database/sqlite/backend-relational.sqlite",
    "BASELINE_SERVER_RASPBERRY/database/sqlite/app-state-split.sqlite",
    "DOCUMENTAZIONE/ROADMAP_RIMANENTE_V5BT_20260817.md",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/contracts/b11-maximum-virtualized-system-non-gate-v2.schema.json",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/contracts/b11-mixed-physical-attestation-v1.schema.json",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/contracts/b11-mixed-physical-virtual-non-gate-v3.schema.json",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/scripts/b11-virtual-business-workload.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/scripts/run-b11-mixed-physical-virtual-non-gate.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/scripts/run-b11-software-non-gate.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/test/b11-hybrid-report-validation.test.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/test/b11-mixed-physical-virtual-non-gate.test.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/test/b11-software-non-gate.test.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/raspberry/test/b11-virtual-business-workload.test.mjs",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.md",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.json",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.md",
    "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/physical/V5BT_B11_MIXED_PHYSICAL_ATTESTATION_REDACTED_20260818.json",
    "scripts/run-b11-mixed-physical-collector.mjs",
    "scripts/run-v5bt-bench-inventory.mjs",
    "scripts/run-v5bt-physical-raspberry-monitor.mjs",
    "scripts/verify-v5bt-advanced-build-consistency.mjs",
    "tests/run-b11-mixed-physical-collector.test.mjs",
    "tests/run-v5bt-bench-inventory.test.mjs",
    "tests/run-v5bt-physical-raspberry-monitor.test.mjs",
    "tests/verify-v5bt-advanced-build-consistency.test.mjs",
  ]) {
    assert.equal(files.has(required), true, `sorgente richiesto assente: ${required}`);
  }

  assert.equal(files.has("APPLICATIVI/ADVANCED_APK_SHA256SUMS"), false);
});

test("la costruzione normalizza metadati e verifica lo ZIP contro l'allowlist", async () => {
  const source = await readFile(script, "utf8");

  assert.match(source, /export LC_ALL=C/);
  assert.match(source, /export TZ=UTC/);
  assert.match(source, /FIXED_TIMESTAMP="202608180000\.00"/);
  assert.match(source, /find "\$stage" -type f -exec chmod 0644/);
  assert.match(source, /PRIVATE_ARCHIVE_FILES=\([\s\S]*V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818\.json[\s\S]*V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818\.json[\s\S]*V5BT_B11_MIXED_PHYSICAL_ATTESTATION_REDACTED_20260818\.json[\s\S]*\)/);
  assert.match(source, /chmod 0600 -- "\$stage\/\$relative"/);
  assert.match(source, /zip -X -q "\$OUTPUT"/);
  assert.match(source, /cmp -s "\$expected_listing" "\$archive_listing"/);
  assert.match(source, /V5BT_SOURCE_MANIFEST\.tsv/);
});

test("l'allowlist conserva le esclusioni per output ricostruibili e dati privati", async () => {
  const source = await readFile(script, "utf8");

  assert.match(source, /INCLUDE_DIRECTORIES=\([\s\S]*\n  scripts\n[\s\S]*\)/);
  for (const directory of [
    ".gradle",
    ".print-spool",
    ".runtime",
    ".v5bt-private",
    "build",
    "cache",
    "dist",
    "keys",
    "logs",
    "node_modules",
    "p4-results",
    "private",
    "registry",
  ]) {
    assert.match(source, new RegExp(`-name ${directory.replace(".", "\\.")}`));
  }
  for (const suffix of ["apk", "jar", "key", "log", "pem", "tar", "zip"]) {
    assert.match(source, new RegExp(`\\*\\.${suffix.replace(".", "\\.")}`));
  }
  assert.match(source, /database\/\*\.sql\.gz/);
  assert.match(source, /\*\/gradle\/wrapper\/gradle-wrapper\.jar/);
});
