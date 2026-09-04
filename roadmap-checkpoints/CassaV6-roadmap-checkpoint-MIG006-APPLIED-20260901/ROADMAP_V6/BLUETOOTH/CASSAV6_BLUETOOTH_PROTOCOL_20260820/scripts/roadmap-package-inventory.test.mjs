import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareRoadmapManifest,
  listRoadmapPackageFiles,
  readRoadmapManifest,
  serializeRoadmapManifest
} from "./roadmap-package-inventory.mjs";

const GENERATOR_PATH = fileURLToPath(
  new URL("./generate-roadmap-manifest.mjs", import.meta.url)
);

function temporaryPackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v6-roadmap-inventory-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, "build"));
  fs.writeFileSync(path.join(root, ".gitignore"), "build/\n");
  fs.writeFileSync(path.join(root, "README.md"), "# V6\n");
  fs.writeFileSync(path.join(root, "scripts", "gate.mjs"), "export {};\n");
  fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored\n");
  fs.writeFileSync(path.join(root, "build", "ignored.js"), "ignored\n");
  return root;
}

test("inventory is canonical and excludes reproducible or private output", () => {
  const root = temporaryPackage();
  try {
    assert.deepEqual(listRoadmapPackageFiles(root), [
      ".gitignore",
      "README.md",
      "scripts/gate.mjs"
    ]);
    assert.equal(
      serializeRoadmapManifest(listRoadmapPackageFiles(root)),
      ".gitignore\nREADME.md\nscripts/gate.mjs\n"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("comparison reports additions and stale declarations in both directions", () => {
  const root = temporaryPackage();
  try {
    const manifest = path.join(root, "MANIFEST.txt");
    fs.writeFileSync(manifest, "README.md\nstale.txt\n");
    const result = compareRoadmapManifest(root, manifest);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.missingFromManifest, [
      ".gitignore",
      "MANIFEST.txt",
      "scripts/gate.mjs"
    ]);
    assert.deepEqual(result.missingFromPackage, ["stale.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest parser rejects duplicates, whitespace and noncanonical order", () => {
  const root = temporaryPackage();
  try {
    const manifest = path.join(root, "MANIFEST.txt");
    fs.writeFileSync(manifest, "scripts/gate.mjs\n README.md\nscripts/gate.mjs\n");
    const result = readRoadmapManifest(manifest);
    assert.equal(result.errors.some((error) => error.includes("Invalid")), true);
    assert.equal(result.errors.some((error) => error.includes("Duplicate")), true);
    assert.equal(result.errors.some((error) => error.includes("sorted")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inventory rejects symbolic links instead of following them", () => {
  const root = temporaryPackage();
  try {
    fs.symlinkSync(path.join(root, "README.md"), path.join(root, "alias.md"));
    assert.throws(
      () => listRoadmapPackageFiles(root),
      /Symbolic links are not allowed/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inventory rejects sensitive files and nonempty private directories", () => {
  const root = temporaryPackage();
  try {
    fs.writeFileSync(path.join(root, "scripts", "secrets.json"), "{}\n");
    assert.throws(
      () => listRoadmapPackageFiles(root),
      /Sensitive or generated file is forbidden/u
    );
    fs.rmSync(path.join(root, "scripts", "secrets.json"));

    fs.mkdirSync(path.join(root, ".runtime"));
    fs.writeFileSync(path.join(root, ".runtime", "private.json"), "{}\n");
    assert.throws(
      () => listRoadmapPackageFiles(root),
      /Private package directory is not empty/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inventory rejects unknown top-level entries and file extensions", () => {
  const root = temporaryPackage();
  try {
    fs.mkdirSync(path.join(root, "unexpected"));
    assert.throws(
      () => listRoadmapPackageFiles(root),
      /Top-level package entry is not allowlisted/u
    );
    fs.rmSync(path.join(root, "unexpected"), { recursive: true, force: true });

    fs.writeFileSync(path.join(root, "scripts", "payload.bin"), "binary\n");
    assert.throws(
      () => listRoadmapPackageFiles(root),
      /Package file extension is not allowlisted/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest generation includes itself and always verifies the result", () => {
  const root = temporaryPackage();
  try {
    const result = spawnSync(
      process.execPath,
      [GENERATOR_PATH, "--root", root, "--write"],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(
      fs.readFileSync(path.join(root, "MANIFEST.txt"), "utf8"),
      ".gitignore\nMANIFEST.txt\nREADME.md\nscripts/gate.mjs\n"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
