import { createServer } from "node:net";

const HOST = process.env.MOCK_PRINTER_HOST || "127.0.0.1";
const PORT = Number(process.env.MOCK_PRINTER_PORT || 9109);

let connections = 0;
let bytes = 0;

const server = createServer((socket) => {
  connections += 1;
  let closeTimer = null;
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!socket.destroyed) socket.end();
    }, 20);
  };
  socket.on("data", (chunk) => {
    bytes += chunk.length;
    closeSoon();
  });
  socket.on("end", () => {
    if (!socket.destroyed) socket.end();
  });
  socket.on("error", () => {
    // The printer mock accepts fire-and-forget ESC/POS payloads.
  });
  socket.on("close", () => {
    clearTimeout(closeTimer);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-printer] tcp://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log(`[mock-printer] chiusura: connessioni=${connections}, bytes=${bytes}`);
  server.close(() => process.exit(0));
});
