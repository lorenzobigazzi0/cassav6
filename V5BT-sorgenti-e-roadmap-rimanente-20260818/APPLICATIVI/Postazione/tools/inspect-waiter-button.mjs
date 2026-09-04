const port = Number(process.argv[2] || 9226);
const durationMs = Math.max(1_000, Number(process.argv[3] || 15_000));
const sampleMs = Math.max(100, Number(process.argv[4] || 250));

const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = Array.isArray(pages) ? pages.find((entry) => entry?.webSocketDebuggerUrl) : null;
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

const expression = `(() => {
  const button = document.querySelector('.btn-call');
  const selected = document.querySelector('.order-card.selected');
  const detail = document.querySelector('.detail-view');
  const detailHeader = detail?.querySelector('.detail-header');
  const itemRows = [...document.querySelectorAll('.item-list .order-item')];
  const cancelledItemRows = itemRows.filter((row) => row.classList.contains('postazione-cancelled-item'));
  const firstCancelledStripe = cancelledItemRows[0] ? getComputedStyle(cancelledItemRows[0], '::after') : null;
  const waiters = Array.isArray(window.__postazioneActiveMobileWaiters)
    ? window.__postazioneActiveMobileWaiters
    : [];
  const buttonAfter = button ? getComputedStyle(button, '::after') : null;
  return {
    at: new Date().toISOString(),
    href: window.location.href,
    online: navigator.onLine,
    selectedOrderId: selected?.getAttribute('data-order-id') || selected?.textContent?.match(/#(\\d+)/)?.[1] || '',
    station: document.querySelector('.station-selector .ss-value')?.textContent?.trim() || '',
    corrections: {
      reactOwner: document.documentElement?.dataset?.orderCorrectionsOwner || '',
      legacyBridgeInstalled: window.__postazioneOrderCorrectionsBridgeInstalled === true,
      detailCancelled: detail?.classList.contains('postazione-cancelled-detail') || false,
      detailCorrected: detail?.classList.contains('postazione-correction-detail') || false,
      detailWatermark: detailHeader?.dataset?.stateWatermark || '',
      detailBadgeCount: detailHeader?.querySelectorAll('.postazione-correction-detail-badge').length || 0,
      itemCount: itemRows.length,
      cancelledItemCount: cancelledItemRows.length,
      visibleCancelledItemCount: cancelledItemRows.filter((row) => getComputedStyle(row).display !== 'none').length,
      cancelledStripeClipPath: firstCancelledStripe?.clipPath || ''
    },
    button: button
      ? {
          disabled: button.disabled,
          className: button.className,
          ariaDisabled: button.getAttribute('aria-disabled'),
          title: button.getAttribute('title'),
          text: button.textContent?.trim() || '',
          after: buttonAfter
            ? {
                inset: buttonAfter.inset,
                borderRadius: buttonAfter.borderRadius,
                boxShadow: buttonAfter.boxShadow
              }
            : null
        }
      : null,
    waiters: waiters.map((waiter) => ({
      userId: waiter?.userId || '',
      username: waiter?.username || '',
      name: waiter?.name || waiter?.fullName || '',
      online: waiter?.online,
      activeNow: waiter?.activeNow
    }))
  };
})()`;

let previousSignature = "";
const startedAt = Date.now();
while (Date.now() - startedAt < durationMs) {
  const evaluation = await request("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.text || "Valutazione CDP non riuscita.");
  }
  const snapshot = evaluation.result.value;
  const signature = JSON.stringify({
    selectedOrderId: snapshot.selectedOrderId,
    corrections: snapshot.corrections,
    button: snapshot.button,
    waiters: snapshot.waiters,
  });
  if (signature !== previousSignature) {
    console.log(JSON.stringify(snapshot));
    previousSignature = signature;
  }
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
}

socket.close();
