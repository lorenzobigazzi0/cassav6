import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(currentDir, "..");
const port = Number(process.env.PORT || 5190);
const apiOrigin = String(process.env.API_ORIGIN || "http://127.0.0.1:3001").replace(/\/$/, "");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    const upstream = new URL(`${apiOrigin}${url.pathname}${url.search}`);
    const proxy = http.request(upstream, { method: req.method, headers: { ...req.headers, host: upstream.host } }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    proxy.on("error", (error) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
    req.pipe(proxy);
    return;
  }
  let requested = url.pathname === "/" || url.pathname === "/impostazioni/" ? "/index.html" : url.pathname;
  if (requested.startsWith("/impostazioni/")) requested = requested.slice("/impostazioni".length);
  let filePath = requested === "/index.html" ? path.join(root, "index.html") : path.join(root, requested.replace(/^\//, ""));
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
    let body = await readFile(filePath);
    if (filePath.endsWith("index.html")) {
      body = Buffer.from(body.toString("utf8")
        .replace("<!-- BUILD:CSS -->", '<link rel="stylesheet" href="./src/styles.css" />')
        .replace("<!-- BUILD:JS -->", '<script type="module" src="./src/main.js"></script>'));
    }
    res.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Risorsa non trovata");
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Impostazioni V2: http://localhost:${port}/impostazioni/ · API ${apiOrigin}`));
