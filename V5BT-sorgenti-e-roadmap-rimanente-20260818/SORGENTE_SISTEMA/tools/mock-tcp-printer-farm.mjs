import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const host = String(process.env.MOCK_PRINTER_FARM_HOST || "127.0.0.1").trim();
const ports = String(process.env.MOCK_PRINTER_FARM_PORTS || "9201,9202,9203,9204")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value, index, values) =>
    Number.isInteger(value) && value > 0 && value <= 65535 && values.indexOf(value) === index
  );
const metricsPort = Number(process.env.MOCK_PRINTER_FARM_METRICS_PORT || 9299);

if (ports.length === 0) {
  throw new Error("MOCK_PRINTER_FARM_PORTS non contiene porte TCP valide.");
}

const startedAtMs = Date.now();
const metrics = new Map(
  ports.map((port, index) => [
    port,
    {
      id: `virtual-printer-${index + 1}`,
      port,
      connections: 0,
      bytes: 0,
      lastConnectionAtMs: null,
      lastPayloadAtMs: null,
    },
  ]),
);

const tcpServers = ports.map((port) => {
  const server = createTcpServer((socket) => {
    const item = metrics.get(port);
    item.connections += 1;
    item.lastConnectionAtMs = Date.now();
    let closeTimer = null;
    const closeSoon = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!socket.destroyed) socket.end();
      }, 20);
    };
    socket.on("data", (chunk) => {
      item.bytes += chunk.length;
      item.lastPayloadAtMs = Date.now();
      closeSoon();
    });
    socket.on("end", () => {
      if (!socket.destroyed) socket.end();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => clearTimeout(closeTimer));
  });
  server.listen(port, host);
  return server;
});

function snapshot() {
  return {
    ok: true,
    host,
    startedAtMs,
    uptimeMs: Date.now() - startedAtMs,
    printers: [...metrics.values()].map((entry) => ({ ...entry })),
    totals: [...metrics.values()].reduce(
      (result, entry) => ({
        connections: result.connections + entry.connections,
        bytes: result.bytes + entry.bytes,
      }),
      { connections: 0, bytes: 0 },
    ),
  };
}

const metricsServer = createHttpServer((request, response) => {
  if (request.method === "GET" && ["/", "/health", "/metrics"].includes(request.url || "")) {
    const payload = JSON.stringify(snapshot());
    response.writeHead(200, {
      "content-length": Buffer.byteLength(payload),
      "content-type": "application/json; charset=utf-8",
    });
    response.end(payload);
    return;
  }
  response.writeHead(404).end();
});

metricsServer.listen(metricsPort, host, () => {
  console.log(`[mock-printer-farm] tcp=${ports.map((port) => `${host}:${port}`).join(",")} metrics=http://${host}:${metricsPort}/metrics`);
});

async function shutdown() {
  await Promise.allSettled([
    ...tcpServers.map((server) => new Promise((resolve) => server.close(resolve))),
    new Promise((resolve) => metricsServer.close(resolve)),
  ]);
  console.log(`[mock-printer-farm] chiusura ${JSON.stringify(snapshot().totals)}`);
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
