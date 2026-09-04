const port = Number(process.argv[2] || 9225);
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = Array.isArray(pages) ? pages[0] : null;
if (!page?.webSocketDebuggerUrl) {
  throw new Error(`Nessuna WebView disponibile sulla porta CDP ${port}.`);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const expression = `
  (async () => {
    const outboxProbe = await new Promise((resolve) => {
      const open = indexedDB.open('palmare-offline-v1', 1);
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('outbox', 'readwrite');
        const store = transaction.objectStore('outbox');
        const requestId = '__palmare_verification__';
        store.put({
          requestId,
          idempotencyKey: requestId,
          url: '/api/verification',
          method: 'POST',
          headers: {},
          body: '{}',
          replayMode: 'held',
          status: 'held',
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          nextAttemptAt: Date.now(),
          expiresAt: Date.now() + 60000,
          lastError: 'verification'
        });
        const read = store.get(requestId);
        read.onsuccess = () => {
          const valid = read.result?.requestId === requestId;
          store.delete(requestId);
          transaction.oncomplete = () => resolve(valid);
        };
        transaction.onerror = () => resolve(false);
        transaction.onabort = () => resolve(false);
      };
    });
    const storeCounts = await new Promise((resolve) => {
      const open = indexedDB.open('palmare-offline-v1', 1);
      open.onerror = () => resolve({ cache: -1, outbox: -1 });
      open.onsuccess = async () => {
        const database = open.result;
        const countStore = (name) => new Promise((done) => {
          const request = database.transaction(name, 'readonly').objectStore(name).count();
          request.onsuccess = () => done(request.result);
          request.onerror = () => done(-1);
        });
        resolve({ cache: await countStore('api-cache'), outbox: await countStore('outbox') });
      };
    });
    return {
      href: window.location.href,
      title: document.title,
      secureContext: window.isSecureContext,
      online: navigator.onLine,
      config: await fetch('/mobile/config.json', { cache: 'no-store' }).then((response) => response.json()),
      databases: typeof indexedDB.databases === 'function'
        ? await indexedDB.databases()
        : [{ name: 'API indexedDB.databases non disponibile' }],
      outboxProbe,
      storeCounts,
      nativeBattery: (() => {
        try {
          const raw = window.AmaliaNativeBattery?.getSnapshot?.() || '';
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })(),
      batteryNetworkRequests: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('/api/mobile/battery')),
      identity: {
        username: localStorage.getItem('pos_user') || '',
        fullName: localStorage.getItem('pos_full_name') || '',
        roomName: localStorage.getItem('pos_room_name') || ''
      },
      ui: {
        topbarTitle: document.querySelector('.topbar-title, .menu-stage-title')?.textContent?.trim() || '',
        radioStatus: document.querySelector('.radio-status-panel strong')?.textContent?.trim() || '',
        radioPermission: document.querySelector('.radio-status-panel span')?.textContent?.trim() || '',
        tableTiles: document.querySelectorAll('.table-tile').length,
        roomCard: document.querySelector('.mobile-dashboard-room-card')?.textContent?.trim() || '',
        offlineBanner: document.querySelector('.palmare-offline-banner')?.textContent?.trim() || '',
        batteryLabel: document.querySelector('.mobile-battery-widget')?.getAttribute('aria-label') || '',
        error: document.querySelector('[role="alert"], .error-boundary')?.textContent?.trim() || ''
      }
    };
  })()
`;
const evaluation = await request("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
socket.close();

if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.text || "Valutazione CDP non riuscita.");
}
console.log(JSON.stringify(evaluation.result.value, null, 2));
