import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packager = path.join(root, "tools", "create-v6-package.sh");
const fixedTimestampMs = Date.UTC(2026, 7, 20, 0, 0, 0);
const maxBuffer = 32 * 1024 * 1024;

const requiredDirectories = [
  "APPLICATIVI",
  "DOCUMENTAZIONE",
  "ROADMAP_BLUETOOTH",
  "ROADMAP_V6",
  "SORGENTE_SISTEMA",
  "database",
  "deploy",
  "scripts",
  "tests",
  "tools",
];

const requiredRootFiles = [
  "CONTENUTO_PACCHETTO.md",
  "HANDOFF_V5BT_20260724.md",
  "HANDOFF_V6_20260820.md",
  "LEGGIMI.md",
  "README_V5BT.md",
  "README_V6.md",
  "V5BT_SOURCE_ARCHIVE_INFO.txt",
  "V5BT_SOURCE_MANIFEST.tsv",
  "V6_BOOTSTRAP_MANIFEST.tsv",
  "V6_BOOTSTRAP_MANIFEST.tsv.sha256",
  "V6_BOOTSTRAP_PROVENANCE.md",
  "hardware.env.example",
  "start-v6.sh",
  "stop-v6.sh",
];

function runPackager(args, cwd = root, options = {}) {
  const { env, ...spawnOptions } = options;
  return spawnSync(packager, args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    ...spawnOptions,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer,
    ...options,
  });
}

function assertSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label}: ${result.stderr || result.stdout || result.error || "errore sconosciuto"}`,
  );
}

function assertRejected(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label}: comando accettato inaspettatamente`);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern, label);
}

async function write(relative, contents, mode = 0o644, base) {
  const destination = path.join(base, relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, contents, { mode });
  await chmod(destination, mode);
}

async function createFixture(parent) {
  const fixture = await mkdtemp(path.join(parent, "source-"));
  await Promise.all(
    requiredDirectories.map((relative) =>
      mkdir(path.join(fixture, relative), { recursive: true, mode: 0o700 }),
    ),
  );

  for (const relative of requiredRootFiles) {
    const executable = relative === "start-v6.sh" || relative === "stop-v6.sh";
    await write(relative, `fixture:${relative}\n`, executable ? 0o755 : 0o644, fixture);
  }
  await chmod(path.join(fixture, "V5BT_SOURCE_ARCHIVE_INFO.txt"), 0o600);
  await chmod(path.join(fixture, "V5BT_SOURCE_MANIFEST.tsv"), 0o600);
  await chmod(path.join(fixture, "V6_BOOTSTRAP_MANIFEST.tsv"), 0o600);
  await chmod(path.join(fixture, "V6_BOOTSTRAP_MANIFEST.tsv.sha256"), 0o600);

  await write("scripts/example.mjs", "export const fixture = true;\n", 0o644, fixture);
  await write("ROADMAP_V6/README.md", "# Roadmap V6\n", 0o664, fixture);
  return fixture;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function parseManifest(contents) {
  assert.ok(contents.endsWith("\n"), "manifest senza newline finale");
  return contents
    .trimEnd()
    .split("\n")
    .map((line) => {
      const fields = line.split("\t");
      assert.equal(fields.length, 4, `riga manifest non canonica: ${line}`);
      const [mode, sizeText, digest, relative] = fields;
      assert.match(mode, /^0(?:600|644|755)$/);
      assert.match(sizeText, /^(?:0|[1-9][0-9]*)$/);
      assert.match(digest, /^[0-9a-f]{64}$/);
      assert.ok(relative.length > 0);
      assert.equal(path.posix.isAbsolute(relative), false, relative);
      assert.equal(relative.split("/").includes(".."), false, relative);
      assert.doesNotMatch(relative, /[\x00-\x1f\x7f\\]/);
      return { mode, size: Number(sizeText), digest, relative };
    });
}

test("il packager V6 usa l'allowlist della tree corrente", { timeout: 120_000 }, async () => {
  const result = runPackager(["--list-only"]);
  assertSucceeded(result, "inventario V6");
  assert.equal(result.stderr, "");

  const files = result.stdout.trimEnd().split("\n");
  assert.ok(files.length > 3_000, `inventario V6 insolitamente corto: ${files.length}`);
  assert.deepEqual(files, [...new Set(files)].sort(), "inventario non ordinato o duplicato");

  const inventory = new Set(files);
  for (const required of [
    "ROADMAP_V6/configs/current-roadmap-status.json",
    "ROADMAP_V6/contracts/current-roadmap-status-v1.schema.json",
    "tools/create-v6-package.sh",
    "tests/v6-package.test.mjs",
    "APPLICATIVI/Palmare/android-app/app/src/test/resources/tls/tls-server-valid.p12",
    "APPLICATIVI/Palmare/android-app/app/src/test/resources/tls/tls-server-expired.p12",
    "APPLICATIVI/Postazione/android-app/app/src/test/resources/tls/tls-server-valid.p12",
    "APPLICATIVI/Postazione/android-app/app/src/test/resources/tls/tls-server-expired.p12",
    "SORGENTE_SISTEMA/settings-frontend/dist/index.html",
    "start-v6.sh",
    "stop-v6.sh",
  ]) {
    assert.equal(inventory.has(required), true, `file V6 richiesto assente: ${required}`);
  }

  for (const relative of files) {
    assert.equal(path.posix.isAbsolute(relative), false, relative);
    assert.equal(relative.split("/").includes(".."), false, relative);
    assert.doesNotMatch(relative, /[\x00-\x1f\x7f\\]/);
    assert.doesNotMatch(relative.toLowerCase(), /(?:^|\/)\.runtime(?:\/|$)/);
    assert.doesNotMatch(relative.toLowerCase(), /(?:^|\/)(?:keys|private|secrets)(?:\/|$)/);
    assert.doesNotMatch(relative.toLowerCase(), /(?:^|\/)baseline_server_raspberry(?:\/|$)/);
    assert.doesNotMatch(relative.toLowerCase(), /^database\/.*\.sql\.gz$/);
  }
});

test("traversal, symlink, file speciali e segreti sono fail-closed", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "v6-package-security-"));
  try {
    const fixture = await createFixture(temporary);
    const traversal = `${fixture}/../${path.basename(fixture)}`;
    assertRejected(
      runPackager(["--list-only", "--source-root", traversal]),
      /Traversal non ammesso/,
      "source traversal",
    );

    const link = path.join(fixture, "scripts", "unsafe-link");
    await symlink(path.join(fixture, "LEGGIMI.md"), link);
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /symlink o file speciale non ammesso/,
      "symlink sorgente",
    );
    await rm(link);

    const ignoredDirectory = path.join(fixture, "scripts", "node_modules", ".bin");
    await mkdir(ignoredDirectory, { recursive: true, mode: 0o700 });
    const ignoredLink = path.join(ignoredDirectory, "unsafe-link");
    await symlink(path.join(fixture, "LEGGIMI.md"), ignoredLink);
    const ignoredResult = runPackager(["--list-only", "--source-root", fixture]);
    assertSucceeded(ignoredResult, "directory generata potata");
    assert.doesNotMatch(
      ignoredResult.stdout,
      /node_modules/,
      "directory generata presente nell'inventario",
    );
    await rm(path.join(fixture, "scripts", "node_modules"), { recursive: true, force: true });

    const fifo = path.join(fixture, "scripts", "unsafe.pipe");
    const fifoResult = run("mkfifo", [fifo]);
    assertSucceeded(fifoResult, "creazione FIFO fixture");
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /symlink o file speciale non ammesso/,
      "FIFO sorgente",
    );
    await rm(fifo);

    const secret = path.join(fixture, "scripts", ".env");
    await writeFile(secret, "TOKEN=not-a-real-token\n", { mode: 0o600 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /percorso sensibile non ammesso/,
      "file segreto",
    );
    await rm(secret);

    const v6Secret = path.join(fixture, "deploy", "cassav6.env");
    await writeFile(v6Secret, "TOKEN=fixture-only\n", { mode: 0o600 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /percorso sensibile non ammesso/,
      "file segreto CASSAV6",
    );
    await rm(v6Secret);

    const v6PrivateDirectory = path.join(fixture, "scripts", ".cassav6-private");
    await mkdir(v6PrivateDirectory, { mode: 0o700 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /directory sensibile non ammessa/,
      "directory privata CASSAV6",
    );
    await rm(v6PrivateDirectory, { recursive: true, force: true });

    const databaseDump = path.join(fixture, "database", "production.sql.gz");
    await writeFile(databaseDump, "compressed-production-fixture\n", { mode: 0o600 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /binario fuori allowlist/,
      "dump SQL compresso",
    );
    await rm(databaseDump);

    const baseline = path.join(fixture, "BASELINE_SERVER_RASPBERRY");
    await mkdir(baseline, { mode: 0o700 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /directory root fuori allowlist/,
      "baseline Raspberry reale",
    );
    await rm(baseline, { recursive: true, force: true });

    const legacyLauncher = path.join(fixture, "start-v5bt.sh");
    await writeFile(legacyLauncher, "#!/usr/bin/env bash\n", { mode: 0o755 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /file root fuori allowlist/,
      "launcher V5BT attivo",
    );
    await rm(legacyLauncher);

    const controlPath = path.join(fixture, "scripts", `unsafe-${String.fromCharCode(0x1b)}.txt`);
    await writeFile(controlPath, "fixture\n", { mode: 0o600 });
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /carattere di controllo/,
      "nome con ESC",
    );
    await rm(controlPath);

    const privateMarker = path.join(fixture, "scripts", "unsafe.txt");
    const privateKeyBlock = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "fixture-only",
      ["-----END", "PRIVATE KEY-----"].join(" "),
      "",
    ].join("\n");
    await writeFile(
      privateMarker,
      privateKeyBlock,
      { mode: 0o600 },
    );
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /marker di chiave privata non ammesso/,
      "marker chiave privata",
    );
    await rm(privateMarker);

    const binaryMarker = path.join(fixture, "scripts", "unsafe.bin");
    await writeFile(
      binaryMarker,
      Buffer.concat([Buffer.from([0]), Buffer.from(privateKeyBlock)]),
      { mode: 0o600 },
    );
    assertRejected(
      runPackager(["--list-only", "--source-root", fixture]),
      /marker di chiave privata non ammesso/,
      "marker chiave privata in contenuto binario",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("l'output rifiuta overwrite, symlink e traversal senza alterare il target", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "v6-package-output-"));
  try {
    const fixture = await createFixture(temporary);
    const existing = path.join(temporary, "existing.zip");
    const sentinel = Buffer.from("sentinel-do-not-overwrite\n");
    await writeFile(existing, sentinel, { mode: 0o600 });
    assertRejected(
      runPackager(["--source-root", fixture, "--output", existing]),
      /output gia esistente/,
      "output preesistente",
    );
    assert.deepEqual(await readFile(existing), sentinel);

    const symlinkTarget = path.join(temporary, "symlink-target.txt");
    const symlinkOutput = path.join(temporary, "symlink.zip");
    await writeFile(symlinkTarget, sentinel, { mode: 0o600 });
    await symlink(symlinkTarget, symlinkOutput);
    assertRejected(
      runPackager(["--source-root", fixture, "--output", symlinkOutput]),
      /output gia esistente/,
      "output symlink",
    );
    assert.deepEqual(await readFile(symlinkTarget), sentinel);
    assert.equal((await lstat(symlinkOutput)).isSymbolicLink(), true);

    assertRejected(
      runPackager([
        "--source-root",
        fixture,
        "--output",
        `${temporary}/nested/../traversal.zip`,
      ]),
      /Traversal non ammesso/,
      "output traversal",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test(
  "due build fixture sono byte-identiche, atomiche e verificabili dal manifest",
  { timeout: 300_000 },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "v6-package-determinism-"));
    try {
      const fixture = await createFixture(temporary);
      const first = path.join(temporary, "first.zip");
      const second = path.join(temporary, "second.zip");

      const firstBuild = runPackager(["--source-root", fixture, "--output", first]);
      assertSucceeded(firstBuild, "prima build");
      const secondBuild = runPackager(["--source-root", fixture, "--output", second]);
      assertSucceeded(secondBuild, "seconda build");

      const [firstBytes, secondBytes, firstStat, secondStat] = await Promise.all([
        readFile(first),
        readFile(second),
        stat(first),
        stat(second),
      ]);
      assert.deepEqual(firstBytes, secondBytes, "le due build non sono byte-identiche");
      assert.equal(sha256(firstBytes), sha256(secondBytes));
      assert.equal(firstStat.mode & 0o777, 0o600);
      assert.equal(secondStat.mode & 0o777, 0o600);
      assert.match(firstBuild.stdout, /Radice: v6\//);
      assert.match(firstBuild.stdout, /Manifest: V6_PACKAGE_MANIFEST\.tsv/);
      assert.match(firstBuild.stdout, new RegExp(`SHA-256: ${sha256(firstBytes)}`));

      const beforeNoClobber = Buffer.from(firstBytes);
      assertRejected(
        runPackager(["--source-root", fixture, "--output", first]),
        /output gia esistente/,
        "no-clobber dopo publish",
      );
      assert.deepEqual(await readFile(first), beforeNoClobber);

      const listingResult = run("unzip", ["-Z1", first]);
      assertSucceeded(listingResult, "listing ZIP");
      const archivePaths = listingResult.stdout.trimEnd().split("\n");
      assert.ok(archivePaths.every((entry) => entry.startsWith("v6/")));
      assert.ok(archivePaths.every((entry) => !entry.endsWith("/")));
      assert.equal(
        archivePaths.filter((entry) => entry === "v6/V6_PACKAGE_MANIFEST.tsv").length,
        1,
      );
      assert.deepEqual(archivePaths, [...archivePaths].sort(), "ordine ZIP non canonico");

      const manifestResult = run("unzip", [
        "-p",
        first,
        "v6/V6_PACKAGE_MANIFEST.tsv",
      ]);
      assertSucceeded(manifestResult, "lettura manifest ZIP");
      const entries = parseManifest(manifestResult.stdout);
      const relativePaths = entries.map(({ relative }) => relative);
      assert.deepEqual(relativePaths, [...new Set(relativePaths)].sort());
      assert.deepEqual(
        archivePaths,
        [...relativePaths.map((relative) => `v6/${relative}`), "v6/V6_PACKAGE_MANIFEST.tsv"].sort(),
      );

      const extraction = path.join(temporary, "extracted");
      await mkdir(extraction, { mode: 0o700 });
      const extractResult = run("unzip", ["-q", first, "-d", extraction], {
        env: { ...process.env, TZ: "UTC" },
      });
      assertSucceeded(extractResult, "estrazione ZIP");

      for (const entry of entries) {
        const extracted = path.join(extraction, "v6", entry.relative);
        const [metadata, contents] = await Promise.all([stat(extracted), readFile(extracted)]);
        assert.equal(metadata.isFile(), true, entry.relative);
        assert.equal(`0${(metadata.mode & 0o777).toString(8)}`, entry.mode, entry.relative);
        assert.equal(metadata.size, entry.size, entry.relative);
        assert.equal(sha256(contents), entry.digest, entry.relative);
        assert.equal(metadata.mtimeMs, fixedTimestampMs, entry.relative);
      }

      const extractedManifest = path.join(extraction, "v6", "V6_PACKAGE_MANIFEST.tsv");
      const manifestMetadata = await stat(extractedManifest);
      assert.equal(manifestMetadata.mode & 0o777, 0o600);
      assert.equal(manifestMetadata.mtimeMs, fixedTimestampMs);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test("il sorgente usa staging temporaneo e publish atomico no-clobber", async () => {
  const source = await readFile(packager, "utf8");
  assert.match(source, /ARCHIVE_ROOT="v6"/);
  assert.match(source, /FIXED_TIMESTAMP="202608200000\.00"/);
  assert.match(source, /temporary="\$\(mktemp -d\)"/);
  assert.match(source, /mktemp -d --tmpdir="\$output_parent"/);
  assert.match(source, /chmod 0700 "\$publish_directory"/);
  assert.match(source, /mv -T -n -- "\$archive_path" "\$OUTPUT"/);
  assert.match(source, /temporary_identity="\$\(stat -c '%d:%i'/);
  assert.match(source, /chmod 0600 "\$archive_path"/);
  assert.match(source, /V6_PACKAGE_MANIFEST\.tsv/);
});
