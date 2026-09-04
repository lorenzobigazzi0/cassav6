import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(currentDir, "..");
const dist = path.join(root, "dist");
const assets = path.join(dist, "assets");

await rm(dist, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await cp(path.join(root, "src"), assets, { recursive: true });
let html = await readFile(path.join(root, "index.html"), "utf8");
html = html
  .replace("<!-- BUILD:CSS -->", '<link rel="stylesheet" href="./assets/styles.css" />')
  .replace("<!-- BUILD:JS -->", '<script type="module" src="./assets/main.js"></script>');
await writeFile(path.join(dist, "index.html"), html, "utf8");
console.log(`settings-frontend costruito in ${dist}`);
