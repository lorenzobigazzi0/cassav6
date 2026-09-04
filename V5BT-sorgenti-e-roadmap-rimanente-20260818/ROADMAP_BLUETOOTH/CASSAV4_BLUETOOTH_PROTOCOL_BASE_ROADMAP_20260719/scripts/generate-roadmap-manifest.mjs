#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  compareRoadmapManifest,
  listRoadmapPackageFiles,
  serializeRoadmapManifest
} from "./roadmap-package-inventory.mjs";

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= process.argv.length) {
    throw new Error(`${name} requires a value`);
  }
  return process.argv[index + 1];
}

const root = path.resolve(optionValue("--root", "."));
const manifestPath = path.join(root, "MANIFEST.txt");
const write = process.argv.includes("--write");

if (write) {
  const entries = listRoadmapPackageFiles(root);
  if (!entries.includes("MANIFEST.txt")) entries.push("MANIFEST.txt");
  fs.writeFileSync(manifestPath, serializeRoadmapManifest(entries), {
    encoding: "utf8",
    mode: 0o644
  });
}

const result = compareRoadmapManifest(root, manifestPath);
const ok =
  result.errors.length === 0 &&
  result.missingFromManifest.length === 0 &&
  result.missingFromPackage.length === 0;
console.log(JSON.stringify({ ok, ...result }, null, 2));
if (!ok) process.exitCode = 1;
