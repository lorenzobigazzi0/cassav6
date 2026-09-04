import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RELEASE_REQUIRED_PATHS,
  validateReleasePackage,
} from "../../scripts/package-guardrails.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(testDir, "..", "..");
const sourceRoot = path.resolve(cassaRoot, "..");

async function createMinimalPackageRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cassav4-package-"));
  for (const relativePath of RELEASE_REQUIRED_PATHS) {
    const absolutePath = path.join(root, relativePath);
    const basename = path.basename(relativePath);
    const isDirectory = !path.extname(basename);
    if (isDirectory) {
      await mkdir(absolutePath, { recursive: true });
    } else {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, basename.endsWith(".json") ? "{}\n" : "ok\n");
    }
  }
  return root;
}

test("release package guardrails accept the release-package source layout", async () => {
  const root = await createMinimalPackageRoot();
  try {
    const findings = await validateReleasePackage(root);
    assert.deepEqual(findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release package guardrails reject runtime, DB, spool and snapshot artifacts", async () => {
  const root = await createMinimalPackageRoot();
  try {
    await mkdir(path.join(root, "cassa-frontend", "backend", ".print-spool"), { recursive: true });
    await writeFile(path.join(root, "cassa-frontend", "backend", ".print-spool", "job.txt"), "print\n");
    await writeFile(path.join(root, "cassa-frontend", "backend", "app-state.sqlite"), "");
    await writeFile(path.join(root, "cassa-frontend", "backend", "app-state.before-test.json"), "{}\n");

    const findings = await validateReleasePackage(root);
    const types = new Set(findings.map((finding) => finding.type));
    const messages = findings.map((finding) => finding.message).join("\n");
    assert.ok(types.has("forbidden_directory"), messages);
    assert.ok(types.has("forbidden_file"), messages);
    assert.match(messages, /\.print-spool/);
    assert.match(messages, /app-state\.sqlite/);
    assert.match(messages, /app-state\.before-test\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release package guardrails reject a package missing runtime report modules", async () => {
  const root = await createMinimalPackageRoot();
  const missingPath = path.join(
    root,
    "cassa-frontend",
    "backend",
    "modules",
    "reports",
    "index.js",
  );
  try {
    await rm(missingPath, { force: true });
    const findings = await validateReleasePackage(root);
    const messages = findings.map((finding) => finding.message).join("\n");
    assert.match(messages, /backend\/modules\/reports\/index\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source preflight validates the current direct source root", () => {
  const result = spawnSync(process.execPath, ["scripts/package-preflight.mjs", "--source", "--root", sourceRoot, "--json"], {
    cwd: cassaRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "source");
});

test("release-package dry-run exposes the canonical runtime excludes", () => {
  const result = spawnSync(process.execPath, ["scripts/release-package.mjs", "--dry-run"], {
    cwd: cassaRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.excludes.includes(".print-spool/"));
  assert.ok(payload.excludes.includes("logs/"));
  assert.ok(payload.excludes.includes("node_modules/"));
  assert.ok(payload.excludes.includes("/cassa-frontend/reports/"));
  assert.ok(!payload.excludes.includes("reports/"));
  assert.ok(payload.excludes.includes("app-state.json"));
});
